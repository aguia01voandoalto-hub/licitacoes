// Analista: baixa o edital no PNCP, manda para o Claude e devolve a análise estruturada.
// A chave da Anthropic fica só aqui (segredo ANTHROPIC_API_KEY). O acesso é protegido por um código (segredo ANALISTA_TOKEN).
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";

const MODELO = Deno.env.get("ANALISTA_MODELO") ?? "claude-sonnet-5-5";
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
- Em "riscos", aponte o que pode dar prejuízo ou desclassificação: garantias, amostras, atestados difíceis, prazos curtos de entrega, multas altas, exigências de fabricante, local de entrega distante.
- A recomendação é para uma pequena empresa fornecedora do tipo de objeto licitado. Seja prudente: prefira "participar_com_ressalvas" a "participar" quando houver risco relevante.
- Escreva em português do Brasil, claro e direto.`;

type Arquivo = { titulo?: string; tipoDocumentoNome?: string; url: string };

function pontuar(a: Arquivo): number {
  const t = `${a.tipoDocumentoNome ?? ""} ${a.titulo ?? ""}`.toLowerCase();
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
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO, max_tokens: 6000, system: SISTEMA,
      tools: [{ name: "registrar_analise", description: "Registra a análise estruturada do edital.", input_schema: SCHEMA }],
      tool_choice: { type: "tool", name: "registrar_analise" },
      messages: [{ role: "user", content: [conteudo.bloco, { type: "text", text: contexto + "\n\nAnalise este edital." }] }],
    }),
  });
  const corpo = await r.json();
  if (!r.ok) throw new Erro(502, `A API da Anthropic recusou o pedido: ${corpo?.error?.message ?? r.status}`);
  const uso = corpo.content?.find((c: { type: string }) => c.type === "tool_use");
  if (!uso) throw new Erro(502, "O Claude não devolveu a análise estruturada.");
  return uso.input as Record<string, unknown>;
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
    const { id, arquivos_api, opp = {}, forcar = false, dry = false } = await req.json();
    if (!/^\d{14}-\d-\d{6}\/\d{4}$/.test(id ?? "")) throw new Erro(400, "Identificador da licitação inválido.");
    if (!/^https:\/\/pncp\.gov\.br\/api\/pncp\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+\/arquivos$/.test(arquivos_api ?? "")) throw new Erro(400, "Endereço dos arquivos inválido.");

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "licitacoes" } });
    if (!forcar && !dry) {
      const { data } = await db.from("analises").select("dados").eq("id", id).maybeSingle();
      if (data) return json({ dados: data.dados, cache: true });
    }
    const limite = Number(Deno.env.get("ANALISTA_LIMITE_DIA") ?? 40);
    const { count } = await db.from("analises").select("id", { count: "exact", head: true }).like("origem", "analista%").gte("gerada_em", new Date(Date.now() - 864e5).toISOString());
    if (!dry && (count ?? 0) >= limite) throw new Erro(429, `Limite diário de análises atingido (${limite}). Tente amanhã.`);

    const arq = await escolherArquivo(arquivos_api);
    const conteudo = await prepararConteudo(arq.bytes, arq.nome);
    if (dry) return json({ ok: true, arquivo: conteudo.arquivo, tipo: conteudo.tipo, bytes: conteudo.bytes, paginas_total: conteudo.paginasTotal, paginas_lidas: conteudo.paginasLidas });

    const analise = await chamarClaude(conteudo, opp);
    const dados = { ...analise, id, edital: conteudo.arquivo, paginas_total: conteudo.paginasTotal, paginas_lidas: conteudo.paginasLidas,
      gerado_por: `Analista (${MODELO}) leu ${conteudo.paginasLidas ? conteudo.paginasLidas + " páginas de " : ""}${conteudo.arquivo}.` };
    await db.from("oportunidades").upsert({
      id, orgao: opp.orgao ?? null, uf: opp.uf ?? null, municipio: opp.municipio ?? null, objeto: opp.objeto ?? null,
      valor_estimado: opp.valor_estimado ?? null, modalidade: opp.modalidade ?? null, encerramento_proposta: opp.encerramento_proposta ?? null,
      link_origem: opp.link_origem ?? null, arquivos_api, numero_compra: opp.numero_compra ?? null, ano: opp.ano ?? null, processo: opp.processo ?? null,
    }, { onConflict: "id", ignoreDuplicates: true });
    const { error } = await db.from("analises").upsert({ id, dados, modelo: MODELO, origem: "analista-edge" }, { onConflict: "id" });
    if (error) throw new Erro(500, "A análise ficou pronta, mas não foi possível guardá-la: " + error.message);
    return json({ dados, cache: false });
  } catch (e) {
    if (e instanceof Erro) return json({ erro: e.message }, e.status);
    console.error(e);
    return json({ erro: "Erro inesperado no Analista: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
