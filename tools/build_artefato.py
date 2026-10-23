#!/usr/bin/env python3
"""Gera dist/artefato.html: o produto.html com uma cópia dos dados embutida e sem o cabeçalho de documento.

Serve para publicar a página num ambiente que bloqueia chamadas ao banco (ex.: artefatos do claude.ai).
Junta as oportunidades do banco com data/oportunidades.json, quando existir. Para a cópia não ficar enorme, guarda só
as que casam com alguma palavra do catálogo de áreas (o catálogo vem do próprio produto.html).
"""
import json, os, re, unicodedata, urllib.request
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://qywemhkqrpjtrcdorxub.supabase.co"
CHAVE = "sb_publishable__ck00oz4LaKprpGUyYb6ag_sNO-oRoO"


def ler(tabela):
    req = urllib.request.Request(f"{URL}/rest/v1/{tabela}?select=*&limit=1000",
                                 headers={"apikey": CHAVE, "Accept-Profile": "licitacoes"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def norm(t):
    return "".join(c for c in unicodedata.normalize("NFD", (t or "").lower()) if unicodedata.category(c) != "Mn")


html = open(os.path.join(RAIZ, "produto.html"), encoding="utf-8").read()
catalogo = json.loads(re.search(r"/\*CAT_INI\*/(.*?)/\*CAT_FIM\*/", html, re.S).group(1))
termos = {t for a in catalogo.values() for t in a["termos"]}
padrao = re.compile(r"\b(?:" + "|".join(re.escape(norm(t)) for t in termos) + r")(?:s|es)?\b")

ops = {o["id"]: o for o in ler("oportunidades")}
analises = {a["id"]: a["dados"] for a in ler("analises")}
local = os.path.join(RAIZ, "data", "oportunidades.json")
if os.path.exists(local):
    for o in json.load(open(local, encoding="utf-8")):
        ops[o["id"]] = o
ops = {i: o for i, o in ops.items() if padrao.search(norm(o.get("objeto")))}
for o in ops.values():
    for k in ("atualizado_em", "pontuacao", "palavras"):
        o.pop(k, None)

for lixo in ('<!doctype html>\n', '<html lang="pt-BR">\n', '<meta charset="utf-8">\n',
             '<meta name="viewport" content="width=device-width,initial-scale=1">\n'):
    html = html.replace(lixo, "", 1)
snap = {"data": date.today().strftime("%d/%m/%Y"), "oportunidades": list(ops.values()), "analises": analises}
html = html.replace("/*SNAPSHOT*/null", json.dumps(snap, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"), 1)
os.makedirs(os.path.join(RAIZ, "dist"), exist_ok=True)
open(os.path.join(RAIZ, "dist", "artefato.html"), "w", encoding="utf-8").write(html)
print(len(ops), "oportunidades,", len(analises), "análises ->", "dist/artefato.html", len(html) // 1024, "KB")
