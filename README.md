# Time de Licitações

Quatro agentes de IA que encontram, analisam e preparam a participação em licitações públicas (Lei 14.133/2021).

- **Farejador** (`farejador/farejador.py`): consulta o PNCP e filtra pelo perfil em `perfil.json`.
- **Analista**: lê o edital e extrai requisitos, prazos e multas.
- **Despachante**: cofre de documentos e conferência de habilitação.
- **Redator**: rascunhos de proposta e declarações.

Banco: Supabase, esquema `licitacoes` (dados públicos). Segredos ficam em `.env`, nunca no Git.

## Publicação

A página é um arquivo só (`produto.html`). A Vercel publica a pasta `site/`, que recebe uma cópia dele:

```
python tools/publicar.py      # copia produto.html para site/index.html
git add -A && git commit -m "..." && git push
```

Cada push na branch `main` publica de novo. Não há segredos na página: a chave do Supabase que ela usa é a pública, e o banco só permite leitura.
