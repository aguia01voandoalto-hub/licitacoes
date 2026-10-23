# Time de Licitações

Quatro agentes de IA que encontram, analisam e preparam a participação em licitações públicas (Lei 14.133/2021).

- **Farejador** (`farejador/farejador.py`): consulta o PNCP e filtra pelo perfil em `perfil.json`.
- **Analista**: lê o edital e extrai requisitos, prazos e multas.
- **Despachante**: cofre de documentos e conferência de habilitação.
- **Redator**: rascunhos de proposta e declarações.

Banco: Supabase, esquema `licitacoes` (dados públicos). Segredos ficam em `.env`, nunca no Git.
