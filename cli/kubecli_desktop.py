"""Terminal desktop visual para executar a kubecli e ferramentas Kubernetes."""
from __future__ import annotations

import json
import os
import platform
import pty
import queue
import re
import select
import signal
import shlex
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox


BG = "#111111"
FG = "#e6e6e6"
MUTED = "#777777"
GREEN = "#65d48b"
RED = "#ff6b6b"
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class TerminalWindow(tk.Tk):
    KUBECLI_COMMANDS = {
        "ctx", "ns", "x", "n", "k", "kubens", "kubectx", "oc", "aliases",
        "cloud", "install", "uninstall", "setup", "list", "prompt", "shell-init",
        "kubeconfig", "pods", "po", "svc", "deploy", "nodes", "events",
        "logs", "describe", "exec",
    }
    KUBECTL_COMMANDS = {
        "get", "apply", "delete", "create", "describe", "logs", "exec",
        "top", "run", "scale", "rollout", "port-forward", "expose",
        "label", "annotate", "patch", "edit", "cp", "auth", "api-resources",
        "api-versions", "cluster-info", "config", "version",
    }

    def __init__(self) -> None:
        super().__init__()
        self.title("K8sOps Terminal")
        self.geometry("980x620")
        self.minsize(700, 420)
        self.configure(background=BG)
        self.project_dir = Path.cwd()
        # Este app usa exclusivamente o kubeconfig padrão do usuário.
        self.kubeconfig = str(Path.home() / ".kube" / "config")
        self.history: list[str] = []
        self.history_index = 0
        self.events: queue.Queue[tuple[str, str]] = queue.Queue()
        self.process: subprocess.Popen[str] | None = None
        self.prompt_prefix = "kubecli"
        self.prompt_active = False
        self.input_enabled = True
        self.pty_master: int | None = None
        self._build_ui()
        self.after(30, self._drain_events)
        self._print("K8sOps Terminal\n", GREEN)
        self._print(f"Diretório: {self.project_dir}\n", MUTED)
        self._print("Digite 'help' para ver os atalhos.\n\n", MUTED)
        self._show_prompt()

    def _build_ui(self) -> None:
        top = tk.Frame(self, bg="#1b1b1b", height=34)
        top.pack(fill="x")
        top.pack_propagate(False)
        tk.Label(top, text="  K8sOps", bg="#1b1b1b", fg=GREEN, font=("Menlo", 11, "bold")).pack(side="left")
        self.config_label = tk.Label(top, text=self.kubeconfig or "kubeconfig padrão", bg="#1b1b1b", fg=MUTED, font=("Menlo", 10))
        self.config_label.pack(side="left", padx=16)
        self._toolbar_button(top, "Editar kubeconfig", self.edit_kubeconfig).pack(side="right", padx=8, pady=4)
        self._toolbar_button(top, "Escolher kubeconfig", self.choose_kubeconfig).pack(side="right", padx=8, pady=4)
        self._toolbar_button(top, "Abrir Terminal", self.open_terminal).pack(side="right", pady=4)

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=12, pady=(10, 0))
        scrollbar = tk.Scrollbar(body)
        scrollbar.pack(side="right", fill="y")
        self.output = tk.Text(
            body,
            bg=BG,
            fg=FG,
            insertbackground=FG,
            selectbackground="#3d5068",
            font=("Menlo", 12),
            relief="flat",
            borderwidth=0,
            highlightthickness=0,
            wrap="none",
            yscrollcommand=scrollbar.set,
            undo=False,
        )
        self.output.pack(side="left", fill="both", expand=True)
        scrollbar.config(command=self.output.yview)
        self.output.tag_configure("context_prompt", foreground="#ff5c5c")
        self.output.tag_configure("namespace_prompt", foreground="#ffd75f")
        self.output.bind("<Key>", self._handle_key)
        self.output.bind("<Button-1>", lambda _event: self._move_cursor_to_input())
        self.output.focus_set()

    def _toolbar_button(self, parent: tk.Misc, text: str, command) -> tk.Label:
        button = tk.Label(
            parent,
            text=text,
            bg="#303030",
            fg="#f0f0f0",
            font=("Menlo", 10),
            padx=10,
            pady=3,
            cursor="hand2",
        )
        button.bind("<Button-1>", lambda _event: command())
        button.bind("<Enter>", lambda _event: button.configure(bg="#454545"))
        button.bind("<Leave>", lambda _event: button.configure(bg="#303030"))
        return button

    def _handle_key(self, event: tk.Event) -> str | None:
        if event.keysym.lower() == "c" and event.state & 0x4 and self.process is not None:
            self._interrupt_process()
            return "break"
        if self.pty_master is not None and self.process is not None:
            self._forward_to_process(event)
            return "break"
        if not self.input_enabled:
            return "break"
        if event.keysym == "Return":
            self._submit_command()
            return "break"
        if event.keysym == "Up":
            self._history(-1)
            return "break"
        if event.keysym == "Down":
            self._history(1)
            return "break"
        if event.keysym == "BackSpace" and self.output.compare("insert", "<=", "prompt_end"):
            return "break"
        if event.keysym == "Left" and self.output.compare("insert", "<=", "prompt_end"):
            return "break"
        if event.char and not (event.state & 0x4):
            self.after_idle(self._keep_input_at_end)
        return None

    def _interrupt_process(self) -> None:
        """Interrompe o comando atual e devolve uma nova linha ao prompt."""
        process = self.process
        if process is None:
            return
        try:
            if self.pty_master is not None:
                os.write(self.pty_master, b"\x03")
            else:
                os.killpg(process.pid, signal.SIGINT)
        except (OSError, ProcessLookupError):
            try:
                process.send_signal(signal.SIGINT)
            except OSError:
                pass
        self._print("^C\n", RED)

    def _forward_to_process(self, event: tk.Event) -> None:
        """Envia teclas para comandos interativos executados no PTY."""
        if self.pty_master is None:
            return
        data = ""
        if event.keysym.lower() == "c" and event.state & 0x4:
            data = "\x03"
        elif event.keysym == "Return":
            data = "\r"
        elif event.keysym == "BackSpace":
            data = "\x7f"
        elif event.keysym == "Tab":
            data = "\t"
        elif event.char and not (event.state & 0x4):
            data = event.char
        if data:
            try:
                os.write(self.pty_master, data.encode())
            except OSError:
                self.pty_master = None

    def _show_prompt(self) -> None:
        context, namespace = self._current_context_info()
        self.prompt_prefix = f"[{context} | {namespace}]"
        self.prompt_active = True
        self.output.mark_set("prompt_start", "end-1c")
        self.output.mark_gravity("prompt_start", "left")
        self.output.mark_set("prompt_end", "end-1c")
        self.output.mark_gravity("prompt_end", "left")
        self.output.insert("end", "[")
        self.output.insert("end", context, "context_prompt")
        self.output.insert("end", " | ")
        self.output.insert("end", namespace, "namespace_prompt")
        self.output.insert("end", "] ❯ ")
        self.output.mark_set("prompt_end", "end-1c")
        self.output.mark_set("insert", "end-1c")
        self.output.see("end")

    def _keep_input_at_end(self) -> None:
        if self.output.compare("insert", "<", "prompt_end"):
            self.output.mark_set("insert", "end-1c")

    def _move_cursor_to_input(self) -> None:
        self.output.mark_set("insert", "end-1c")
        self.output.focus_set()

    def _submit_command(self) -> None:
        command = self.output.get("prompt_end", "end-1c").strip()
        self.output.insert("end", "\n")
        self.prompt_active = False
        if not command:
            self._show_prompt()
            return
        self.history.append(command)
        self.history_index = len(self.history)
        if command == "clear":
            self.output.delete("1.0", "end")
            self._show_prompt()
            return
        if command == "help":
            self._print("Atalhos: clear, pwd, kubeconfig, terminal, exit\nExemplos rápidos: ctx list, ns list, get pods -A, pods, k get pods\nComandos explícitos: kubectl, kubecli, helm e qualquer executável disponível no PATH.\n\n", MUTED)
            self._show_prompt()
            return
        if command == "pwd":
            self._print(f"{self.project_dir}\n\n")
            self._show_prompt()
            return
        if command == "kubeconfig":
            self.choose_kubeconfig()
            return
        if command == "terminal":
            self.open_terminal()
            self._show_prompt()
            return
        if command == "exit":
            self.destroy()
            return
        expanded = self._expand_command(command)
        if self._is_installation_command(expanded):
            self._open_native_command(expanded)
            self._print("Instalação delegada ao Terminal nativo.\n\n", MUTED)
            self._show_prompt()
            return
        self.input_enabled = False
        self._run_command(expanded)

    def _expand_command(self, command: str) -> str:
        """Expande atalhos para manter o terminal rápido de usar."""
        try:
            args = shlex.split(command)
        except ValueError:
            return command
        if not args:
            return command

        first = args[0]
        # `k` é um atalho direto para kubectl; não passa novamente pela CLI.
        # Assim `k get pods` nunca herda comportamento de aliases externos,
        # como watch (`-w`).
        if first == "k":
            return "kubectl " + " ".join(shlex.quote(item) for item in args[1:])
        if first == "get" and len(args) >= 2 and args[1] == "pods":
            return "kubectl " + " ".join(shlex.quote(item) for item in args)
        if first in self.KUBECLI_COMMANDS:
            return "kubecli " + command
        if first in self.KUBECTL_COMMANDS:
            return "kubectl " + command
        return command

    def _history(self, direction: int) -> None:
        if not self.history:
            return
        self.history_index = max(0, min(len(self.history), self.history_index + direction))
        value = self.history[self.history_index] if self.history_index < len(self.history) else ""
        self.output.delete("prompt_end", "end-1c")
        self.output.insert("end", value)
        self.output.mark_set("insert", "end-1c")

    def _run_command(self, command: str) -> None:
        env = os.environ.copy()
        env["KUBECONFIG"] = self.kubeconfig
        if os.name != "posix" or not self._needs_pty(command):
            self._run_command_pipe(command, env)
            return
        try:
            master, slave = pty.openpty()
            self.pty_master = master
            self.process = subprocess.Popen(
                ["zsh", "-lc", command],
                cwd=self.project_dir,
                env=env,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
                close_fds=True,
            )
            os.close(slave)
        except OSError as error:
            self.pty_master = None
            self._print(f"Erro: {error}\n\n", RED)
            self.input_enabled = True
            self._show_prompt()
            return
        threading.Thread(target=self._read_pty, args=(self.process, master), daemon=True).start()

    def _needs_pty(self, command: str) -> bool:
        """Usa PTY somente quando o comando precisa de interação contínua."""
        try:
            args = shlex.split(command)
        except ValueError:
            return False
        if not args:
            return False
        interactive = {"exec", "attach", "port-forward", "proxy"}
        if any(item in interactive for item in args):
            return True
        if any(item in {"install", "cloud", "configure", "login"} for item in args):
            return True
        if args[:2] in (["kubecli", "kubeconfig"], ["kubecli", "aliases"]):
            return True
        return "-f" in args or "--follow" in args or "-w" in args or "--watch" in args

    def _is_installation_command(self, command: str) -> bool:
        try:
            args = shlex.split(command)
        except ValueError:
            return False
        return "install" in args or "uninstall" in args or "setup" in args

    def _open_native_command(self, command: str) -> None:
        """Executa instalações no terminal real para suportar input e sudo."""
        env_line = f"export KUBECONFIG={shlex.quote(self.kubeconfig)}; "
        shell_command = (
            f"cd {shlex.quote(str(self.project_dir))}; {env_line}"
            f"{command}; printf '\\n[comando finalizado - pressione Enter]'; read; exec zsh"
        )
        try:
            if platform.system() == "Darwin":
                subprocess.Popen([
                    "osascript",
                    "-e",
                    f'tell application "Terminal" to activate\n'
                    f'tell application "Terminal" to do script {json.dumps(shell_command)}',
                ])
            elif platform.system() == "Linux":
                subprocess.Popen(["x-terminal-emulator", "-e", "bash", "-lc", shell_command])
            else:
                self._run_command(command)
        except OSError as error:
            self._print(f"Não foi possível abrir o Terminal nativo: {error}\n\n", RED)

    def _run_command_pipe(self, command: str, env: dict[str, str]) -> None:
        try:
            self.process = subprocess.Popen(
                ["sh", "-lc", command],
                cwd=self.project_dir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
                start_new_session=True,
            )
        except OSError as error:
            self._print(f"Erro: {error}\n\n", RED)
            self.input_enabled = True
            self._show_prompt()
            return
        threading.Thread(target=self._read_process, args=(self.process,), daemon=True).start()

    def _read_pty(self, process: subprocess.Popen[str], master: int) -> None:
        try:
            while True:
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        data = os.read(master, 4096)
                    except OSError:
                        break
                    if data:
                        self.events.put(("output", data.decode(errors="replace")))
                if process.poll() is not None and not ready:
                    break
        finally:
            os.close(master)
            self.events.put(("done", f"[{process.wait()}]\n\n"))

    def _read_process(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        while True:
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            self.events.put(("output", chunk.decode(errors="replace")))
        code = process.wait()
        self.events.put(("done", f"[{code}]\n\n"))

    def _drain_events(self) -> None:
        output_parts: list[str] = []
        finished: list[str] = []
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "output":
                    output_parts.append(value)
                else:
                    finished.append(value)
        except queue.Empty:
            pass
        if output_parts:
            self._print("".join(output_parts))
        for value in finished:
            self.process = None
            self.pty_master = None
            self._print(value, GREEN if value.startswith("[0]") else RED)
            self._print("\n")
            self.input_enabled = True
            self.output.mark_set("insert", "end-1c")
            self._show_prompt()
        self.after(30, self._drain_events)

    def _print(self, text: str, color: str = FG) -> None:
        text = self._clean_terminal_output(text)
        if not text:
            return
        start = self.output.index("end-1c")
        self.output.insert("end", text)
        tag = f"color_{color[1:]}"
        if not self.output.tag_ranges(tag):
            self.output.tag_configure(tag, foreground=color)
        self.output.tag_add(tag, start, "end-1c")
        self.output.see("end")

    @staticmethod
    def _clean_terminal_output(text: str) -> str:
        """Remove sequências ANSI de progresso/cor que o Tkinter não interpreta."""
        text = ANSI_ESCAPE.sub("", text)
        text = CONTROL_CHARS.sub("", text)
        return text.replace("\r\n", "\n").replace("\r", "\n")

    def _current_context_info(self) -> tuple[str, str]:
        env = os.environ.copy()
        env["KUBECONFIG"] = self.kubeconfig
        try:
            context_result = subprocess.run(
                ["kubectl", "config", "current-context"],
                env=env,
                text=True,
                capture_output=True,
                timeout=3,
            )
            context = context_result.stdout.strip() or "sem-contexto"
            namespace_result = subprocess.run(
                ["kubectl", "config", "view", "--minify", "-o", "jsonpath={.contexts[0].context.namespace}"],
                env=env,
                text=True,
                capture_output=True,
                timeout=3,
            )
            namespace = namespace_result.stdout.strip() or "default"
            return context, namespace
        except (OSError, subprocess.SubprocessError):
            return "sem-contexto", "default"

    def choose_kubeconfig(self) -> None:
        selected = filedialog.askopenfilename(
            title="Selecionar kubeconfig",
            initialdir=str(Path.home() / ".kube"),
        )
        if selected:
            if self.prompt_active:
                self.output.delete("prompt_start", "end")
                self.prompt_active = False
            self.kubeconfig = selected
            self.config_label.config(text=selected)
            self._print(f"KUBECONFIG definido: {selected}\n\n", MUTED)
            self._show_prompt()

    def edit_kubeconfig(self) -> None:
        """Abre o kubeconfig atual no editor de texto padrão do sistema."""
        path = Path(self.kubeconfig).expanduser()
        if not path.exists():
            create = messagebox.askyesno(
                "Kubeconfig não encontrado",
                f"O arquivo não existe:\n{path}\n\nDeseja criá-lo vazio?",
            )
            if not create:
                return
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            except OSError as error:
                messagebox.showerror("Erro", f"Não foi possível criar o arquivo:\n{error}")
                return
        try:
            if platform.system() == "Darwin":
                subprocess.Popen(["open", "-t", str(path)])
            elif platform.system() == "Linux":
                subprocess.Popen(["xdg-open", str(path)])
            elif platform.system() == "Windows":
                os.startfile(str(path))  # type: ignore[attr-defined]
            else:
                raise OSError("sistema operacional não suportado")
        except OSError as error:
            messagebox.showerror("Erro", f"Não foi possível abrir o editor:\n{error}")

    def open_terminal(self) -> None:
        path = self.kubeconfig
        env_line = f"export KUBECONFIG={shlex.quote(str(Path(path).expanduser()))}; " if path else ""
        command = f"cd {shlex.quote(str(self.project_dir))}; {env_line} exec zsh"
        if platform.system() == "Darwin":
            subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script {json.dumps(command)}'])
        elif platform.system() == "Linux":
            subprocess.Popen(["x-terminal-emulator", "-e", "bash", "-lc", command])
        else:
            messagebox.showinfo("Terminal", "Abertura automática disponível para macOS e Linux.")


def main() -> None:
    TerminalWindow().mainloop()


if __name__ == "__main__":
    main()
