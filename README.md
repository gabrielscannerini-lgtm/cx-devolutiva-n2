
# Yuca — Aprimorar Devolutiva N2 (HubSpot → OpenAI → HubSpot)

Substitui o cenário do Make. Quando a propriedade **Devolutiva de N2** (`devolutiva_de_n2`)
de um ticket muda, o HubSpot dispara um webhook para esta function no Netlify, que:

1. valida a origem (assinatura v3);
2. confirma o filtro de negócio (pipeline N1, departamento Engenharia, não fechado);
3. acha o contato associado ao ticket;
4. chama a OpenAI (seu prompt salvo) para transformar a devolutiva em mensagem para o yuker;
5. grava o resultado em `hs_chat_assistant_summary` **no contato**.

O envio do WhatsApp via **Treble continua no workflow do HubSpot**, que reage ao
preenchimento de `hs_chat_assistant_summary` — igual hoje.

## Por que webhook e não polling

A subscription de `ticket.propertyChange` é registrada **apenas** para a propriedade
`devolutiva_de_n2`. O HubSpot só chama a function quando exatamente essa propriedade muda —
sem ruído de outras edições, sem backlog histórico, sem necessidade de Data Store.

## Setup

### 1. App privado no HubSpot
Escopos: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.tickets.read`.
Anote o **access token** (`pat-...`), o **Client Secret** (aba Auth) e o **App ID**.

### 2. Deploy no Netlify
- Suba este repositório e conecte ao Netlify (mesmo padrão do Idwall).
- Configure as variáveis de ambiente conforme `.env.example`.
- A function fica em:
  `https://<seu-site>.netlify.app/.netlify/functions/hubspot-webhook`

### 3. Registrar o webhook (via API, uma vez)
Precisa do **developer API key** da conta de desenvolvedor e do **App ID**.

Registrar o targetUrl:
```
PUT https://api.hubapi.com/webhooks/v3/{appId}/settings
{
  "targetUrl": "https://<seu-site>.netlify.app/.netlify/functions/hubspot-webhook",
  "throttling": { "maxConcurrentRequests": 10, "period": "SECONDLY" }
}
```

Criar a subscription (só a propriedade que importa):
```
POST https://api.hubapi.com/webhooks/v3/{appId}/subscriptions
{
  "eventType": "ticket.propertyChange",
  "propertyName": "devolutiva_de_n2",
  "active": true
}
```

## Confirmar antes de ativar
- `PIPELINE_N1_ID` — internal id do pipeline N1.
- `DEPARTAMENTO_ESPERADO` — valor interno exato da opção "Engenharia" em `departamento__n2`.
- `STAGE_FECHADO_ID` — internal id do stage fechado (deixe vazio para não filtrar por stage).
- O prompt salvo (`OPENAI_PROMPT_ID`) tem a variável `{{devolutiva_n2}}` no corpo.

## Notas
- A function é idempotente: se `hs_chat_assistant_summary` do contato já estiver preenchido,
  ela não reprocessa.
- Erros pontuais em um evento não derrubam o lote; o HubSpot reenvia em caso de 4xx/5xx.
