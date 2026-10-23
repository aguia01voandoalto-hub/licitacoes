#!/usr/bin/env python3
"""Farejador: busca contratações com propostas abertas no PNCP e filtra pelo perfil da empresa.

Uso:
  python farejador/farejador.py                 # grava data/oportunidades.json
  python farejador/farejador.py --supabase      # também grava no Supabase (precisa de SUPABASE_URL e SUPABASE_SERVICE_KEY)
"""
import argparse, json, os, re, sys, time, unicodedata
from concurrent.futures import ThreadPoolExecutor
import urllib.parse, urllib.request, urllib.error
from datetime import date, datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta"
PAGINA = 50


def normalizar(t):
    t = unicodedata.normalize("NFD", (t or "").lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def get(url, tentativas=4):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "farejador/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                corpo = r.read()
                return json.loads(corpo) if corpo else {"data": []}
        except urllib.error.HTTPError as e:
            if e.code == 204:
                return {"data": []}
            if i == tentativas - 1:
                raise
        except Exception:
            if i == tentativas - 1:
                raise
        time.sleep(2 ** i)


def buscar(uf, modalidade, ate):
    pagina, total = 1, 1
    while pagina <= total:
        q = urllib.parse.urlencode({
            "dataFinal": ate.strftime("%Y%m%d"), "codigoModalidadeContratacao": modalidade,
            "uf": uf, "pagina": pagina, "tamanhoPagina": PAGINA})
        d = get(f"{API}?{q}")
        total = d.get("totalPaginas", 1) or 1
        for r in d.get("data", []):
            yield r
        pagina += 1


def _termo(k):
    # palavra inteira, aceitando plural simples: "impressora" casa "impressoras", mas "monitor" não casa "monitoramento"
    return re.compile(r"\b" + re.escape(normalizar(k)) + r"(?:s|es)?\b")


def pontuar(objeto, perfil):
    t = normalizar(objeto)
    if any(normalizar(x) in t for x in perfil["excluir"]):
        return 0, []
    achados = [k for k in perfil["termos"] if _termo(k).search(t)]
    return sum(perfil["termos"][k] for k in achados), achados


def converter(r, pontos, achados):
    cnpj, ano, seq = r["orgaoEntidade"]["cnpj"], r["anoCompra"], r["sequencialCompra"]
    u = r.get("unidadeOrgao") or {}
    enc = r.get("dataEncerramentoProposta")
    if enc:
        enc = datetime.fromisoformat(enc).replace(tzinfo=timezone(timedelta(hours=-3))).astimezone(timezone.utc).isoformat()
    return {
        "id": r["numeroControlePNCP"], "pontuacao": pontos, "palavras": achados,
        "orgao": r["orgaoEntidade"].get("razaoSocial"), "uf": u.get("ufSigla"), "municipio": u.get("municipioNome"),
        "objeto": r.get("objetoCompra"), "valor_estimado": r.get("valorTotalEstimado"),
        "modalidade": r.get("modalidadeNome"), "encerramento_proposta": enc,
        "link_origem": r.get("linkSistemaOrigem") or r.get("linkProcessoEletronico"),
        "arquivos_api": f"https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos",
        "numero_compra": r.get("numeroCompra"), "ano": ano, "processo": r.get("processo"),
    }


def enviar_supabase(itens):
    url, chave = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"]
    for i in range(0, len(itens), 200):
        req = urllib.request.Request(
            f"{url}/rest/v1/oportunidades?on_conflict=id", data=json.dumps(itens[i:i + 200]).encode(), method="POST",
            headers={"apikey": chave, "Authorization": f"Bearer {chave}", "Content-Type": "application/json",
                     "Content-Profile": "licitacoes", "Prefer": "resolution=merge-duplicates,return=minimal"})
        urllib.request.urlopen(req, timeout=60).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--supabase", action="store_true")
    ap.add_argument("--dias", type=int, default=60, help="janela de encerramento das propostas")
    a = ap.parse_args()
    perfil = json.load(open(os.path.join(RAIZ, "perfil.json"), encoding="utf-8"))
    ate = date.today() + timedelta(days=a.dias)
    agora = datetime.now(timezone.utc)
    achadas, vistas = {}, 0

    def varrer(uf_mod):
        uf, mod = uf_mod
        saida, lidas = [], 0
        for r in buscar(uf, mod, ate):
            lidas += 1
            v = r.get("valorTotalEstimado")
            if v is not None and not (perfil["valor_min"] <= v <= perfil["valor_max"]):
                continue
            pts, achados = pontuar(r.get("objetoCompra"), perfil)
            if pts < perfil["min_pontuacao"]:
                continue
            item = converter(r, pts, achados)
            if item["encerramento_proposta"] and datetime.fromisoformat(item["encerramento_proposta"]) < agora:
                continue
            saida.append(item)
        print(f"{uf} modalidade {mod}: {lidas} lidas, {len(saida)} aprovadas", file=sys.stderr)
        return lidas, saida

    pares = [(uf, mod) for uf in perfil["ufs"] for mod in perfil["modalidades"]]
    with ThreadPoolExecutor(max_workers=5) as ex:
        for lidas, saida in ex.map(varrer, pares):
            vistas += lidas
            for item in saida:
                achadas[item["id"]] = item
    itens = sorted(achadas.values(), key=lambda x: (-x["pontuacao"], x["encerramento_proposta"] or ""))
    os.makedirs(os.path.join(RAIZ, "data"), exist_ok=True)
    json.dump(itens, open(os.path.join(RAIZ, "data", "oportunidades.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(itens)} oportunidades gravadas em data/oportunidades.json")
    if a.supabase:
        enviar_supabase(itens)
        print("enviado ao Supabase")


if __name__ == "__main__":
    main()
