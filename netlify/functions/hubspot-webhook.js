'use strict';

const crypto = require('crypto');

/**
 * Webhook receiver: HubSpot ticket.propertyChange (devolutiva_de_n2)
 *  -> busca contato associado
 *  -> chama OpenAI (Responses API, prompt no código) para transformar a devolutiva
 *  -> grava o resultado em hs_chat_assistant_summary do CONTATO
 *
 * O disparo do WhatsApp (Treble) continua a cargo do workflow do HubSpot,
 * que reage ao preenchimento de hs_chat_assistant_summary.
 */

// ------------------------- Config -------------------------

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Modelo rápido resolve a duração (evita os retries do HubSpot). Sobrescrevível por env.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const PIPELINE_N1_ID = process.env.PIPELINE_N1_ID || '0';
const DEPARTAMENTO_ESPERADO = process.env.DEPARTAMENTO_ESPERADO || 'Engenharia';
const STAGE_FECHADO_ID = process.env.STAGE_FECHADO_ID || '';
// Fase de destino: move o ticket que disparou a function para "Cliente respondido" (N1).
const STAGE_CLIENTE_RESPONDIDO_ID = process.env.STAGE_CLIENTE_RESPONDIDO_ID || '1335407144';

const HS_BASE = 'https://api.hubapi.com';
const WATCHED_PROPERTY = 'devolutiva_de_n2';
const TARGET_PROPERTY = 'hs_chat_assistant_summary';

// ------------------------- Prompt (migrado do prompt object) -------------------------
// A OpenAI está descontinuando os prompt objects (v1/prompts sai em 30/11/2026).
// Conteúdo do prompt agora vive aqui, versionado junto com o código.

const SYSTEM_INSTRUCTIONS = `Você é um assistente de CX da Yuca. Sua tarefa é transformar o texto interno de uma devolutiva de N2 em uma mensagem clara, objetiva e apropriada para ser enviada ao inquilino (yuker) via WhatsApp.

O QUE VOCÊ DEVE FAZER:
Reescreva o texto como uma mensagem direcionada ao inquilino, mantendo APENAS o que faz sentido para ele:
- Atualização/status do chamado
- Número do pedido (apenas se estiver presente e for relevante)
- Próximos passos
- Quem vai entrar em contato com ele

O QUE VOCÊ DEVE REMOVER:
- Saudações a colegas internos ("Ricardo, bom dia", "Oi time", etc.)
- Instruções operacionais entre times ("por gentileza avisar o morador", "favor encaminhar", "abrir chamado no sistema", etc.)
- Qualquer linguagem interna, técnica ou de coordenação entre áreas
- Nomes de responsáveis internos, salvo quando forem quem efetivamente entrará em contato com o inquilino

REGRAS OBRIGATÓRIAS:
1. NÃO invente nenhuma informação. Use somente o que está no texto de entrada.
2. Escreva na segunda pessoa, falando diretamente com o inquilino ("sua solicitação", "entrará em contato com você").
3. Tom cordial, direto e profissional. Sem emojis, sem excesso de formalidade.
4. Não inclua saudação nem despedida — apenas o conteúdo da atualização.
5. Se o texto de entrada estiver vazio, ruim, incompleto, ambíguo, contraditório ou impróprio para envio ao cliente, retorne EXATAMENTE:
"Recebemos uma atualização do seu chamado e nosso time está revisando as próximas etapas antes do envio da resposta final."
6. Retorne SOMENTE a mensagem final, sem explicações, sem aspas, sem comentários.

EXEMPLO:
Entrada:
"Ricardo, bom dia! Por gentileza avisar o morador que estamos enviando a solicitação para a empresa Refera. Número do pedido: 350540. Que a empresa Refera vai entrar em contato com o mesmo para marcar a visita…"
Saída:
Encaminhamos sua solicitação para a empresa Refera. O número do pedido é 350540. A equipe entrará em contato com você para agendar a visita.`;

// ------------------------- Helpers HubSpot -------------------------

function hsHeaders() {
  return {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function hsGet(path) {
  const res = await fetch(`${HS_BASE}${path}`, { headers: hsHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot GET ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

async function hsPatch(path, properties) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method: 'PATCH',
    headers: hsHeaders(),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot PATCH ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

async function getTicket(ticketId) {
  const props = [
    'hs_object_id',
    'subject',
    'hs_pipeline',
    'hs_pipeline_stage',
    WATCHED_PROPERTY,
    'departamento__n2',
  ].join(',');
  return hsGet(`/crm/v3/objects/tickets/${ticketId}?properties=${props}`);
}

async function getAssociatedContactId(ticketId) {
  const data = await hsGet(
    `/crm/v4/objects/tickets/${ticketId}/associations/contacts`
  );
  const results = data.results || [];
  if (results.length === 0) return null;
  return results[0].toObjectId;
}

async function getContact(contactId) {
  const props = ['hs_object_id', 'email', 'phone', 'firstname', 'lastname', TARGET_PROPERTY].join(',');
  return hsGet(`/crm/v3/objects/contacts/${contactId}?properties=${props}`);
}

// ------------------------- OpenAI (Responses API, sem prompt object) -------------------------

async function aprimorarDevolutiva(devolutivaTexto) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: SYSTEM_INSTRUCTIONS,
      input: devolutivaTexto,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI -> ${res.status}: ${body}`);
  }

  const data = await res.json();
  if (data.output_text && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && c.text) chunks.push(c.text);
    }
  }
  return chunks.join('').trim();
}

// ------------------------- Validação de assinatura v3 -------------------------

function validateSignatureV3(event) {
  const signature = event.headers['x-hubspot-signature-v3'];
  const timestamp = event.headers['x-hubspot-request-timestamp'];
  if (!signature || !timestamp) return false;

  const MAX_AGE_MS = 5 * 60 * 1000;
  if (Date.now() - Number(timestamp) > MAX_AGE_MS) return false;

  const method = event.httpMethod;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'];
  const uri = `${proto}://${host}${event.path}`;
  const body = event.body || '';

  const base = `${method}${uri}${body}${timestamp}`;
  const hmac = crypto
    .createHmac('sha256', HUBSPOT_CLIENT_SECRET)
    .update(base, 'utf8')
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ------------------------- Processamento de 1 evento -------------------------

async function processEvent(evt) {
  if (evt.subscriptionType !== 'ticket.propertyChange') return skip('não é ticket.propertyChange');
  if (evt.propertyName !== WATCHED_PROPERTY) return skip(`propriedade ${evt.propertyName} ignorada`);

  const ticketId = evt.objectId;
  const ticket = await getTicket(ticketId);
  const p = ticket.properties || {};

  if (p.hs_pipeline !== PIPELINE_N1_ID) return skip(`pipeline ${p.hs_pipeline} != N1`);
  if ((p.departamento__n2 || '') !== DEPARTAMENTO_ESPERADO)
    return skip(`departamento ${p.departamento__n2} != ${DEPARTAMENTO_ESPERADO}`);
  if (STAGE_FECHADO_ID && p.hs_pipeline_stage === STAGE_FECHADO_ID)
    return skip('ticket em stage fechado');

  const devolutiva = (p[WATCHED_PROPERTY] || '').trim();
  if (!devolutiva) return skip('devolutiva vazia');

  const contactId = await getAssociatedContactId(ticketId);
  if (!contactId) return skip(`ticket ${ticketId} sem contato associado`);

  const contact = await getContact(contactId);
  const cp = contact.properties || {};

  if ((cp[TARGET_PROPERTY] || '').trim()) {
    return skip(`contato ${contactId} já tem ${TARGET_PROPERTY} preenchido`);
  }

  if (!(cp.phone || '').trim()) {
    console.warn(`[aviso] contato ${contactId} sem telefone; Treble pode falhar no envio`);
  }

  const mensagem = await aprimorarDevolutiva(devolutiva);
  if (!mensagem) return skip('OpenAI retornou vazio');

  await hsPatch(`/crm/v3/objects/contacts/${contactId}`, {
    [TARGET_PROPERTY]: mensagem,
  });

  // Move o ticket que disparou a function para "Cliente respondido".
  // Feito por último: se a IA ou a gravação no contato falharem antes,
  // o ticket não é movido indevidamente.
  await hsPatch(`/crm/v3/objects/tickets/${ticketId}`, {
    hs_pipeline_stage: STAGE_CLIENTE_RESPONDIDO_ID,
  });

  console.log(`[ok] ticket ${ticketId} -> contato ${contactId} atualizado + ticket movido para Cliente respondido`);
  return { ticketId, contactId, status: 'updated' };
}

function skip(reason) {
  console.log(`[skip] ${reason}`);
  return { status: 'skipped', reason };
}

// ------------------------- Handler -------------------------

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!validateSignatureV3(event)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let events;
  try {
    events = JSON.parse(event.body || '[]');
    if (!Array.isArray(events)) events = [events];
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const results = [];
  for (const evt of events) {
    try {
      results.push(await processEvent(evt));
    } catch (err) {
      console.error(`[erro] evento ${evt && evt.objectId}: ${err.message}`);
      results.push({ status: 'error', objectId: evt && evt.objectId, message: err.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed: results.length, results }),
  };
};
