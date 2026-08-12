# OpenSearch e stack de monitoramento

Este projeto instala no cluster Kubernetes:

- OpenSearch pelo chart oficial `opensearch/opensearch`;
- `kube-prometheus-stack`, com Prometheus Operator, Prometheus, Alertmanager e Grafana.

Os dois componentes são instalados via `helm_release` no namespace existente `monitoramento`. O Terraform não tenta criar namespaces, pois isso exige permissão no escopo do cluster. Os PVCs usam a StorageClass padrão do cluster quando nenhuma é informada.

## Estrutura

- `main.tf`: composição dos módulos;
- `modules/opensearch`: namespace e release Helm do OpenSearch;
- `modules/monitoring`: namespace e release Helm da stack de monitoramento;
- `helm/*.yaml.tftpl`: valores Helm parametrizados pelo Terraform.


## Uso

```bash
cp terraform.tfvars.example terraform.tfvars
# edite terraform.tfvars e troque as duas senhas

terraform init
terraform plan
terraform apply
```

Para usar um contexto específico, informe `kube_context` no `terraform.tfvars`. Para clusters sem StorageClass padrão, informe `opensearch_storage_class` e `monitoring_storage_class`.

Os serviços são internos ao cluster. Para acesso local:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
kubectl -n opensearch port-forward svc/opensearch-cluster-master 9200:9200
```

Usuários padrão: `admin` no Grafana e no OpenSearch. As senhas são fornecidas pelas variáveis sensíveis e devem ser mantidas em um backend seguro de estado/secret manager.

## CLI Kubernetes/OpenShift

O diretório [`cli/`](cli/) contém uma CLI para `kubectl`, `kubens`, `kubectx` e `oc`. Como o gerenciador usado é o `uv`, instale uma vez com `uv tool install --editable ./cli` e depois use o comando `kubecli` diretamente. Consulte [`cli/README.md`](cli/README.md) para exemplos.
