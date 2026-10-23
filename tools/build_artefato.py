#!/usr/bin/env python3
"""Gera dist/artefato.html: o produto.html com uma cópia dos dados embutida e sem o cabeçalho de documento.

Serve para publicar a página num ambiente que bloqueia chamadas ao banco (ex.: artefatos do claude.ai).
Junta as oportunidades do banco com data/oportunidades.json, quando existir.
"""
import json, os, urllib.request
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://qywemhkqrpjtrcdorxub.supabase.co"
CHAVE = "sb_publishable__ck00oz4LaKprpGUyYb6ag_sNO-oRoO"


def ler(tabela):
    req = urllib.request.Request(f"{URL}/rest/v1/{tabela}?select=*&limit=1000",
                                 headers={"apikey": CHAVE, "Accept-Profile": "licitacoes"})
    return json.load(urllib.request.urlopen(req, timeout=60))


ops = {o["id"]: o for o in ler("oportunidades")}
analises = {a["id"]: a["dados"] for a in ler("analises")}
local = os.path.join(RAIZ, "data", "oportunidades.json")
if os.path.exists(local):
    for o in json.load(open(local, encoding="utf-8")):
        ops[o["id"]] = o
for o in ops.values():
    o.pop("atualizado_em", None)

html = open(os.path.join(RAIZ, "produto.html"), encoding="utf-8").read()
for lixo in ('<!doctype html>\n', '<html lang="pt-BR">\n', '<meta charset="utf-8">\n',
             '<meta name="viewport" content="width=device-width,initial-scale=1">\n'):
    html = html.replace(lixo, "", 1)
snap = {"data": date.today().strftime("%d/%m/%Y"), "oportunidades": list(ops.values()), "analises": analises}
html = html.replace("/*SNAPSHOT*/null", json.dumps(snap, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"), 1)
os.makedirs(os.path.join(RAIZ, "dist"), exist_ok=True)
open(os.path.join(RAIZ, "dist", "artefato.html"), "w", encoding="utf-8").write(html)
print(len(ops), "oportunidades,", len(analises), "análises ->", "dist/artefato.html", len(html) // 1024, "KB")
