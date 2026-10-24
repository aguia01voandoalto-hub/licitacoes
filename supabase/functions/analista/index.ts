// Analista: baixa o edital no PNCP, manda para o Claude e devolve a análise estruturada.
// A chave da Anthropic fica só aqui (segredo ANTHROPIC_API_KEY). O acesso é protegido por um código (segredo ANALISTA_TOKEN).
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";

// Padrão: Haiku (mais barato). Para mais qualidade, defina o segredo ANALISTA_MODELO, por exemplo claude-sonnet-5-5.
const MODELO = Deno.env.get("ANALISTA_MODELO") ?? "claude-haiku-5-5";
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGINAS = 100;
const MAX_CHARS = 350_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-analista-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SCHEMA = {
  type: "object",
  required: ["objeto", "recomendacao", "motivo_recomendacao", "prazos", "habilitacao", "riscos", "penalidades", "lacunas"],
  properties: {
    objeto: { type: "string", description: "O que está sendo comprado, em uma ou duas frases." },
    valor_estimado_edital: { type: ["number", "null"], description: "Valor total estimado que consta no edital, em reais." },
    recomendacao: { type: "string", enum: ["participar", "participar_com_ressalvas", "nao_participar"] },
    motivo_recomendacao: { type: "string", description: "Por que, em linguagem simples, considerando risco, exigências e esforço." },
    prazos: { type: "array", items: { type: "object", required: ["descricao", "data", "trecho"], properties: {
      descricao: { type: "string" }, data: { type: "string" }, pagina: { type: ["integer", "null"] }, trecho: { type: "string" } } } },
    habilitacao: { type: "array", items: { type: "object", required: ["grupo", "exigencia", "trecho"], properties: {
      grupo: { type: "string", enum: ["juridica", "fiscal_trabalhista", "economico_financeira", "tecnica"] },
      exigencia: { type: "string" }, pagina: { type: ["integer", "null"] }, trecho: { type: "string" } } } },
    riscos: { type: "array", items: { type: "object", required: ["descricao", "gravidade", "trecho"], properties: {
      descricao: { type: "string" }, gravidade: { type: "string", enum: ["alta", "media", "baixa"] },
      pagina: { type: ["integer", "null"] }, trecho: { type: "string" } } } },
    penalidades: { type: "array", items: { type: "object", required: ["descricao", "trecho"], properties: {
      descricao: { type: "string" }, pagina: { type: ["integer", "null"] }, trecho: { type: "string" } } } },
    local_entrega_execucao: { type: "string", description: "Onde o objeto deve ser entregue ou o serviço executado (endereço, cidade, unidades). Vazio se o edital não diz." },
    prazo_entrega_execucao: { type: "string", description: "Prazo para entregar ou iniciar/concluir a execução, como no edital (ex.: 15 dias corridos após a ordem de fornecimento)." },
    vigencia_contrato: { type: "string", description: "Vigência do contrato ou da ata de registro de preços e possibilidade de prorrogação." },
    forma_pagamento: { type: "string", description: "Prazo e condições de pagamento (ex.: 30 dias após o aceite da nota fiscal)." },
    garantias: { type: "string", description: "Garantia de proposta, garantia contratual (percentual) e garantia técnica exigida do produto/serviço." },
    visita_amostras: { type: "string", description: "Se exige visita técnica, amostras, prova de conceito ou demonstração, e os prazos para isso." },
    tratamento_me_epp: { type: "string", description: "O que o edital diz sobre ME/EPP (exclusividade, preferência, prazos para regularização)." },
    lacunas: { type: "array", items: { type: "string" }, description: "O que não deu para confirmar (partes não lidas, anexos ausentes, informações ambíguas)." },
  },
};

const SISTEMA = `Você é o Analista de um sistema que ajuda empresas a decidir se participam de licitações públicas brasileiras (Lei 14.133/2021).
Leia o edital e registre a análise chamando a ferramenta registrar_analise.
Regras:
- Use só o que está no documento. Não invente nada. O que não estiver claro vai em "lacunas".
- Cada item de prazos, habilitacao, riscos e penalidades traz um "trecho" copiado literalmente (curto) e a "pagina" do PDF onde ele está. Se o documento não tem páginas, use null.
- Datas e valores exatamente como no edital.
- Preencha local_entrega_execucao, prazo_entrega_execucao, vigencia_contrato, forma_pagamento, garantias e visita_amostras com o que o edital diz; se não disser, deixe a string vazia (não invente).
- Em "riscos", aponte o que pode dar prejuízo ou desclassificação: garantias, amostras, atestados difíceis, prazos curtos de entrega, multas altas, exigências de fabricante, local de entrega distante.
- A recomendação é para uma pequena empresa fornecedora do tipo de objeto licitado. Seja prudente: prefira "participar_com_ressalvas" a "participar" quando houver risco relevante.
- Escreva em português do Brasil, claro e direto.`;

type Arquivo = { titulo?: string; tipoDocumentoNome?: string; url: string; dataPublicacaoPncp?: string };

function pontuar(a: Arquivo): number {
  const t = `${a.tipoDocumentoNome ?? ""} ${a.titulo ?? ""}`.toLowerCase();
  if (/revoga|cancelamento|anula|ata de|resultado|homolog|adjudic|recurso|impugna|esclarecimento|comprovante/.test(t)) return 0;
  if (/edital/.test(t)) return 3;
  if (/aviso|termo de refer|dispensa|preg/.test(t)) return 2;
  return 1;
}
const ext = (nome: string) => (nome.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");

function textoDocx(bytes: Uint8Array): string {
  const z = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = z["word/document.xml"] ? strFromU8(z["word/document.xml"]) : "";
  return xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// Word antigo (.doc, formato binário OLE): lê o fluxo "WordDocument" e remonta o texto pela tabela de pedaços (piece table).
function textoDoc(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 512 || dv.getUint32(0, true) !== 0xE011CFD0) throw new Error("não é um arquivo Word antigo");
  const sec = 1 << dv.getUint16(0x1E, true), nFat = dv.getUint32(0x2C, true), dir0 = dv.getUint32(0x30, true);
  const so = (n: number) => (n + 1) * sec;
  const difat: number[] = []; for (let i = 0; i < 109; i++) { const v = dv.getUint32(0x4C + i * 4, true); if (v < 0xFFFFFFFA) difat.push(v); }
  let dn = dv.getUint32(0x44, true), nd = dv.getUint32(0x48, true);
  while (nd-- > 0 && dn < 0xFFFFFFFA) { for (let i = 0; i < sec / 4 - 1; i++) { const v = dv.getUint32(so(dn) + i * 4, true); if (v < 0xFFFFFFFA) difat.push(v); } dn = dv.getUint32(so(dn) + sec - 4, true); }
  const fat: number[] = []; for (const f of difat.slice(0, nFat)) for (let i = 0; i < sec / 4; i++) fat.push(dv.getUint32(so(f) + i * 4, true));
  const cadeia = (ini: number, max = 1 << 20) => { const o: number[] = []; let n = ini; while (n < 0xFFFFFFFA && o.length < max) { o.push(n); n = fat[n]; } return o; };
  const ler = (ini: number, tam: number) => { const out = new Uint8Array(tam); let p = 0; for (const n of cadeia(ini)) { const ch = bytes.subarray(so(n), so(n) + sec); out.set(ch.subarray(0, Math.min(sec, tam - p)), p); p += sec; if (p >= tam) break; } return out; };
  const dirBytes = new Uint8Array(cadeia(dir0).length * sec); cadeia(dir0).forEach((n, i) => dirBytes.set(bytes.subarray(so(n), so(n) + sec), i * sec));
  const dd = new DataView(dirBytes.buffer), fluxos: Record<string, { ini: number; tam: number }> = {};
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const len = dd.getUint16(o + 0x40, true), tipo = dirBytes[o + 0x42]; if (tipo !== 2 || len < 2) continue;
    let nome = ""; for (let i = 0; i < len / 2 - 1; i++) nome += String.fromCharCode(dd.getUint16(o + i * 2, true));
    fluxos[nome] = { ini: dd.getUint32(o + 0x74, true), tam: dd.getUint32(o + 0x78, true) };
  }
  // fluxos pequenos (< 4096 bytes) ficam no "mini stream", guardado na entrada raiz
  const raiz = (() => { for (let o = 0; o + 128 <= dirBytes.length; o += 128) if (dirBytes[o + 0x42] === 5) return { ini: dd.getUint32(o + 0x74, true), tam: dd.getUint32(o + 0x78, true) }; return null; })();
  const corte = dv.getUint32(0x38, true), msec = 1 << dv.getUint16(0x20, true);
  const miniFat: number[] = []; for (const n of cadeia(dv.getUint32(0x3C, true))) for (let i = 0; i < sec / 4; i++) miniFat.push(dv.getUint32(so(n) + i * 4, true));
  const mini = raiz ? ler(raiz.ini, raiz.tam) : new Uint8Array(0);
  const lerFluxo = (f: { ini: number; tam: number }) => {
    if (f.tam >= corte) return ler(f.ini, f.tam);
    const out = new Uint8Array(f.tam); let p = 0, n = f.ini;
    while (n < 0xFFFFFFFA && p < f.tam) { out.set(mini.subarray(n * msec, n * msec + Math.min(msec, f.tam - p)), p); p += msec; n = miniFat[n]; }
    return out;
  };
  const wd = fluxos["WordDocument"]; if (!wd) throw new Error("sem WordDocument");
  const w = lerFluxo(wd), wv = new DataView(w.buffer);
  const tb = fluxos[(wv.getUint16(0x0A, true) & 0x200) ? "1Table" : "0Table"]; if (!tb) throw new Error("sem tabela");
  const t = lerFluxo(tb), tv = new DataView(t.buffer), fcClx = wv.getUint32(0x1A2, true), lcbClx = wv.getUint32(0x1A6, true);
  let p = fcClx; const fim = fcClx + lcbClx;
  while (p < fim && t[p] === 1) p += 3 + tv.getUint16(p + 1, true);
  if (t[p] !== 2) throw new Error("sem tabela de pedaços");
  const lcb = tv.getUint32(p + 1, true), n = Math.floor((lcb - 4) / 12), cp0 = p + 5, pcd0 = cp0 + (n + 1) * 4;
  const partes: string[] = [];
  for (let i = 0; i < n; i++) {
    const cpIni = tv.getUint32(cp0 + i * 4, true), cpFim = tv.getUint32(cp0 + (i + 1) * 4, true), fc = tv.getUint32(pcd0 + i * 8 + 2, true), len = cpFim - cpIni;
    if (fc & 0x40000000) partes.push(new TextDecoder("windows-1252").decode(w.subarray((fc & 0x3FFFFFFF) >> 1, ((fc & 0x3FFFFFFF) >> 1) + len)));
    else partes.push(new TextDecoder("utf-16le").decode(w.subarray(fc, fc + len * 2)));
  }
  return partes.join("").replace(/\x13[^\x14\x15]*\x14/g, "").replace(/[\x13\x14\x15]/g, "").replace(/[\r\x0b]/g, "\n").replace(/\x07/g, "\t").replace(/[\x00-\x08\x0c\x0e-\x1f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function nomeDoDownload(r: Response, url: string): string {
  const cd = r.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  try { return decodeURIComponent(m?.[1] ?? url.split("/").pop() ?? "arquivo"); } catch { return m?.[1] ?? "arquivo"; }
}

async function baixar(url: string): Promise<{ bytes: Uint8Array; nome: string }> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Erro(502, `O PNCP não entregou o arquivo (HTTP ${r.status}).`);
  const tam = Number(r.headers.get("content-length") ?? 0);
  if (tam > MAX_BYTES) throw new Erro(413, "O arquivo do edital é grande demais para análise automática (acima de 25 MB).");
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Erro(413, "O arquivo do edital é grande demais para análise automática (acima de 25 MB).");
  return { bytes, nome: nomeDoDownload(r, url) };
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip",
  odt: "application/vnd.oasis.opendocument.text", txt: "text/plain; charset=utf-8", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
};
const limpar = (n: string) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(-90) || "arquivo";

// Guarda uma cópia de cada arquivo da licitação no armazenamento (bucket público "editais") e devolve a lista para a tela.
// É idempotente: se a licitação já foi guardada, devolve a lista que está no banco.
// deno-lint-ignore no-explicit-any
async function salvarDocumentos(db: any, empresa: string, id: string, arquivosApi: string): Promise<Record<string, unknown>[]> {
  const { data: ex } = await db.from("documentos").select("itens").eq("empresa_id", empresa).eq("id", id).maybeSingle();
  if (ex?.itens?.length) return ex.itens;
  const r = await fetch(arquivosApi, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Erro(502, `O PNCP não listou os arquivos (HTTP ${r.status}).`);
  const arqs: Arquivo[] = (await r.json()).filter((a: Arquivo) => a.url);
  if (!arqs.length) throw new Erro(404, "Esta licitação não tem arquivos no PNCP.");
  const base = Deno.env.get("SUPABASE_URL")!, pasta = `${empresa}/${id.replace("/", "_")}`;   // cada empresa tem a sua pasta de cópias
  const itens: Record<string, unknown>[] = []; let total = 0;
  for (const [i, a] of arqs.slice(0, 15).entries()) {
    try {
      const b = await baixar(a.url);
      total += b.bytes.length;
      if (total > 90 * 1024 * 1024) { itens.push({ titulo: a.titulo ?? "arquivo", tipo: a.tipoDocumentoNome ?? "", erro: "Não guardado: limite de tamanho da licitação.", origem: a.url }); continue; }
      const nome = b.nome.split("/").pop() || "arquivo", e = ext(nome);
      const path = `${pasta}/${String(i + 1).padStart(2, "0")}-${limpar(nome)}`;
      const up = await db.storage.from("editais").upload(path, b.bytes, { contentType: MIME[e] ?? "application/octet-stream", upsert: true });
      if (up.error) throw new Error(up.error.message);
      itens.push({ titulo: a.titulo ?? nome, tipo: a.tipoDocumentoNome ?? "", nome, ext: e, bytes: b.bytes.length,
        url: `${base}/storage/v1/object/public/editais/${path.split("/").map(encodeURIComponent).join("/")}`, origem: a.url, publicado_em: a.dataPublicacaoPncp ?? null });
    } catch (err) {
      itens.push({ titulo: a.titulo ?? "arquivo", tipo: a.tipoDocumentoNome ?? "", erro: err instanceof Error ? err.message : String(err), origem: a.url });
    }
  }
  if (itens.some((x) => x.url)) await db.from("documentos").upsert({ empresa_id: empresa, id, itens, atualizado_em: new Date().toISOString() }, { onConflict: "empresa_id,id" });
  return itens;
}

class Erro extends Error { constructor(public status: number, msg: string) { super(msg); } }

type Conteudo = { bloco: Record<string, unknown>; arquivo: string; tipo: string; paginasTotal: number | null; paginasLidas: number | null; bytes: number };

async function prepararConteudo(bytes: Uint8Array, nome: string, nivel = 0): Promise<Conteudo> {
  const e = ext(nome), cab = new TextDecoder("latin1").decode(bytes.slice(0, 5));
  if (e === "pdf" || cab.startsWith("%PDF")) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const total = doc.getPageCount();
    let saida = bytes, lidas = total;
    if (total > MAX_PAGINAS) {
      const novo = await PDFDocument.create();
      (await novo.copyPages(doc, Array.from({ length: MAX_PAGINAS }, (_, i) => i))).forEach((p) => novo.addPage(p));
      saida = await novo.save(); lidas = MAX_PAGINAS;
    }
    let bin = ""; for (let i = 0; i < saida.length; i += 0x8000) bin += String.fromCharCode(...saida.subarray(i, i + 0x8000));
    return { bloco: { type: "document", source: { type: "base64", media_type: "application/pdf", data: btoa(bin) } }, arquivo: nome, tipo: "pdf", paginasTotal: total, paginasLidas: lidas, bytes: bytes.length };
  }
  if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) {   // Word antigo (.doc)
    let t = ""; try { t = textoDoc(bytes); } catch (_) { /* cai no erro abaixo */ }
    if (t.length < 200) throw new Erro(422, "O arquivo do edital (Word antigo, .doc) não tem texto que eu consiga ler. Abra o edital pelo link.");
    return { bloco: { type: "text", text: `CONTEÚDO DO EDITAL (${nome}):\n\n${t.slice(0, MAX_CHARS)}` }, arquivo: nome, tipo: "doc", paginasTotal: null, paginasLidas: null, bytes: bytes.length };
  }
  if (cab.startsWith("PK")) {
    if (e === "docx") {
      const t = textoDocx(bytes);
      if (t.length < 200) throw new Erro(422, "O arquivo do edital (Word) não tem texto legível.");
      return { bloco: { type: "text", text: `CONTEÚDO DO EDITAL (${nome}):\n\n${t.slice(0, MAX_CHARS)}` }, arquivo: nome, tipo: "docx", paginasTotal: null, paginasLidas: null, bytes: bytes.length };
    }
    if (nivel === 0) {   // zip: escolhe o melhor arquivo dentro
      const itens = Object.entries(unzipSync(bytes)).filter(([n]) => /\.(pdf|docx)$/i.test(n) && !n.includes("__MACOSX"));
      if (!itens.length) throw new Erro(422, "O pacote do edital não tem PDF nem Word legível.");
      itens.sort((a, b) => (/edital/i.test(b[0]) ? 1 : 0) - (/edital/i.test(a[0]) ? 1 : 0) || b[1].length - a[1].length);
      return prepararConteudo(itens[0][1], itens[0][0].split("/").pop()!, 1);
    }
  }
  throw new Erro(422, `Formato de arquivo não suportado (${e || "desconhecido"}). Abra o edital pelo link e leia manualmente.`);
}

async function escolherArquivo(arquivosApi: string): Promise<{ bytes: Uint8Array; nome: string }> {
  const r = await fetch(arquivosApi, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Erro(502, `O PNCP não listou os arquivos (HTTP ${r.status}).`);
  const lista: Arquivo[] = (await r.json()).filter((a: Arquivo) => a.url);
  if (!lista.length) throw new Erro(404, "Esta licitação não tem arquivo de edital no PNCP.");
  lista.sort((a, b) => pontuar(b) - pontuar(a));
  let ultimo: Erro | null = null;
  for (const a of lista.slice(0, 4)) {
    const b = await baixar(a.url);
    try { await prepararConteudo(b.bytes, b.nome); return b; } catch (e) { if (e instanceof Erro) ultimo = e; else throw e; }
  }
  throw ultimo ?? new Erro(422, "Nenhum arquivo do edital pôde ser lido.");
}

async function chamarClaude(conteudo: Conteudo, opp: Record<string, unknown>) {
  const chave = Deno.env.get("ANTHROPIC_API_KEY");
  if (!chave) throw new Erro(503, "A chave da Anthropic não está configurada no servidor (ANTHROPIC_API_KEY).");
  const contexto = `Dados da licitação no PNCP: órgão ${opp.orgao ?? "?"} (${opp.municipio ?? ""}/${opp.uf ?? ""}); modalidade ${opp.modalidade ?? "?"}; valor estimado ${opp.valor_estimado ?? "sigiloso"}; propostas até ${opp.encerramento_proposta ?? "?"}; objeto resumido: ${opp.objeto ?? "?"}.` +
    (conteudo.paginasTotal && conteudo.paginasLidas! < conteudo.paginasTotal ? `\nATENÇÃO: o PDF tem ${conteudo.paginasTotal} páginas e você recebeu só as primeiras ${conteudo.paginasLidas}. Registre isso em lacunas.` : "");
  // Os modelos novos não aceitam forçar a ferramenta (tool_choice "tool"): deixamos em automático e pedimos a chamada no texto.
  const mensagens: Record<string, unknown>[] = [{ role: "user", content: [conteudo.bloco, { type: "text", text: contexto + "\n\nAnalise este edital e registre o resultado chamando a ferramenta registrar_analise." }] }];
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 8000, system: SISTEMA,
        tools: [{ name: "registrar_analise", description: "Registra a análise estruturada do edital.", input_schema: SCHEMA }],
        messages: mensagens,
      }),
    });
    const corpo = await r.json();
    if (!r.ok) throw new Erro(502, `A API da Anthropic recusou o pedido: ${corpo?.error?.message ?? r.status}`);
    const uso = corpo.content?.find((c: { type: string }) => c.type === "tool_use");
    if (uso) return uso.input as Record<string, unknown>;
    mensagens.push({ role: "assistant", content: corpo.content ?? [] });
    mensagens.push({ role: "user", content: "Registre agora a análise completa chamando a ferramenta registrar_analise." });
  }
  throw new Erro(502, "O modelo não devolveu a análise estruturada. Tente de novo.");
}

// Edital avulso: o usuário envia o arquivo (PDF, Word) que não está no PNCP; vira uma oportunidade da empresa, analisada e guardada como as demais.
// deno-lint-ignore no-explicit-any
async function analisarAvulso(db: any, empresa: string, c: any) {
  const nome = String(c.nome ?? "").slice(0, 200), b64 = String(c.base64 ?? ""), opp = (c.opp ?? {}) as Record<string, unknown>;
  if (!nome || !b64) throw new Erro(400, "Envie o arquivo do edital.");
  if (b64.length > MAX_BYTES * 1.4) throw new Erro(413, "O arquivo é grande demais para análise automática (acima de 25 MB).");
  const limite = Number(Deno.env.get("ANALISTA_LIMITE_DIA") ?? 40);
  const { count } = await db.from("analises").select("id", { count: "exact", head: true }).like("origem", "analista%").gte("gerada_em", new Date(Date.now() - 864e5).toISOString());
  if ((count ?? 0) >= limite) throw new Erro(429, `Limite diário de análises atingido (${limite}). Tente amanhã.`);
  const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const conteudo = await prepararConteudo(bytes, nome);
  const id = `AV-${crypto.randomUUID()}`, e = ext(nome), path = `${empresa}/${id}/01-${limpar(nome)}`;
  const up = await db.storage.from("editais").upload(path, bytes, { contentType: MIME[e] ?? "application/octet-stream", upsert: true });
  const documentos = up.error ? [] : [{ titulo: nome, tipo: "Edital enviado por você", nome, ext: e, bytes: bytes.length,
    url: `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/editais/${path.split("/").map(encodeURIComponent).join("/")}`, origem: null, publicado_em: new Date().toISOString() }];
  const analise = await chamarClaude(conteudo, opp);
  const dados = { ...analise, id, edital: conteudo.arquivo, paginas_total: conteudo.paginasTotal, paginas_lidas: conteudo.paginasLidas,
    gerado_por: `Analista (${MODELO}) leu ${conteudo.paginasLidas ? conteudo.paginasLidas + " páginas de " : ""}${conteudo.arquivo}.` };
  const { error: e1 } = await db.from("oportunidades").insert({ id, orgao: opp.orgao ?? null, objeto: opp.objeto ?? (analise as { objeto?: string }).objeto ?? null, modalidade: "Edital avulso", encerramento_proposta: opp.encerramento_proposta ?? null });
  if (e1) throw new Erro(500, "Não foi possível registrar o edital: " + e1.message);
  const { error } = await db.from("analises").insert({ empresa_id: empresa, id, dados, modelo: MODELO, origem: "analista-avulso" });
  if (error) throw new Erro(500, "A análise ficou pronta, mas não foi possível guardá-la: " + error.message);
  if (documentos.length) await db.from("documentos").upsert({ empresa_id: empresa, id, itens: documentos, atualizado_em: new Date().toISOString() }, { onConflict: "empresa_id,id" });
  return { id, dados, documentos };
}

const tokenOk = (recebido: string | null) => {
  const esperado = Deno.env.get("ANALISTA_TOKEN");
  if (!esperado || !recebido || esperado.length !== recebido.length) return false;
  let d = 0; for (let i = 0; i < esperado.length; i++) d |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return d === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  try {
    if (!Deno.env.get("ANALISTA_TOKEN")) throw new Erro(503, "O código de acesso do Analista ainda não foi configurado no servidor (ANALISTA_TOKEN).");
    if (!tokenOk(req.headers.get("x-analista-token"))) throw new Erro(401, "Código de acesso do Analista incorreto.");
    const corpo = await req.json();
    const { id, empresa_id, arquivos_api, opp = {}, forcar = false, dry = false, acao = "analisar" } = corpo;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(empresa_id ?? "")) throw new Erro(400, "Empresa não informada.");
    if (acao !== "avulso") {
      if (!/^\d{14}-\d-\d{6}\/\d{4}$/.test(id ?? "")) throw new Erro(400, "Identificador da licitação inválido.");
      if (!/^https:\/\/pncp\.gov\.br\/api\/pncp\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+\/arquivos$/.test(arquivos_api ?? "")) throw new Erro(400, "Endereço dos arquivos inválido.");
    }
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "licitacoes" } });
    // Tudo é por empresa: quem chama precisa estar logado e ser o dono da empresa informada.
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) throw new Erro(401, "Entre na sua conta para usar o Analista.");
    const { data: dona } = await db.from("empresas").select("id").eq("id", empresa_id).eq("user_id", u.user.id).maybeSingle();
    if (!dona) throw new Erro(403, "Esta empresa não é da sua conta.");
    if (acao === "avulso") return json(await analisarAvulso(db, empresa_id, corpo));
    if (acao === "documentos") return json({ documentos: await salvarDocumentos(db, empresa_id, id, arquivos_api) });
    if (!forcar && !dry) {
      const { data } = await db.from("analises").select("dados").eq("empresa_id", empresa_id).eq("id", id).maybeSingle();
      if (data) return json({ dados: data.dados, cache: true, documentos: await salvarDocumentos(db, empresa_id, id, arquivos_api).catch(() => []) });
    }
    const limite = Number(Deno.env.get("ANALISTA_LIMITE_DIA") ?? 40);
    const { count } = await db.from("analises").select("id", { count: "exact", head: true }).like("origem", "analista%").gte("gerada_em", new Date(Date.now() - 864e5).toISOString());
    if (!dry && (count ?? 0) >= limite) throw new Erro(429, `Limite diário de análises atingido (${limite}). Tente amanhã.`);

    const arq = await escolherArquivo(arquivos_api);
    const conteudo = await prepararConteudo(arq.bytes, arq.nome);
    if (dry) return json({ ok: true, arquivo: conteudo.arquivo, tipo: conteudo.tipo, bytes: conteudo.bytes, paginas_total: conteudo.paginasTotal, paginas_lidas: conteudo.paginasLidas });

    const documentos = await salvarDocumentos(db, empresa_id, id, arquivos_api).catch(() => []);
    const analise = await chamarClaude(conteudo, opp);
    const dados = { ...analise, id, edital: conteudo.arquivo, paginas_total: conteudo.paginasTotal, paginas_lidas: conteudo.paginasLidas,
      gerado_por: `Analista (${MODELO}) leu ${conteudo.paginasLidas ? conteudo.paginasLidas + " páginas de " : ""}${conteudo.arquivo}.` };
    await db.from("oportunidades").upsert({
      id, orgao: opp.orgao ?? null, uf: opp.uf ?? null, municipio: opp.municipio ?? null, objeto: opp.objeto ?? null,
      valor_estimado: opp.valor_estimado ?? null, modalidade: opp.modalidade ?? null, encerramento_proposta: opp.encerramento_proposta ?? null,
      link_origem: opp.link_origem ?? null, arquivos_api, numero_compra: opp.numero_compra ?? null, ano: opp.ano ?? null, processo: opp.processo ?? null,
    }, { onConflict: "id", ignoreDuplicates: true });
    const { error } = await db.from("analises").upsert({ empresa_id, id, dados, modelo: MODELO, origem: "analista-edge" }, { onConflict: "empresa_id,id" });
    if (error) throw new Erro(500, "A análise ficou pronta, mas não foi possível guardá-la: " + error.message);
    return json({ dados, cache: false, documentos });
  } catch (e) {
    if (e instanceof Erro) return json({ erro: e.message }, e.status);
    console.error(e);
    return json({ erro: "Erro inesperado no Analista: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
