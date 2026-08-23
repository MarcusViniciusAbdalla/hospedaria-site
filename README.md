# Hospedaria Central Morrinhos

Sistema completo de reservas e gestão hoteleira, com site público de busca e checkout, e painel administrativo integrado para operação do dia a dia.

🔗 **Demo ao vivo:** [hospedaria-site.onrender.com](https://hospedaria-site.onrender.com)

---

## Sobre o projeto

A Hospedaria Central é uma pousada localizada no centro de Morrinhos-GO. Este sistema resolve o fluxo completo do negócio: um visitante busca disponibilidade por data, reserva um quarto, paga via Pix ou cartão, e recebe confirmação automática por e-mail e WhatsApp — enquanto a administração acompanha tudo em um painel próprio, sem depender de planilhas ou anotações manuais.

O projeto foi construído para rodar com custo operacional mínimo: sem serviços pagos além do essencial (banco de dados, gateway de pagamento e hospedagem), usando APIs HTTP diretas em vez de bibliotecas pesadas onde fazia sentido.

---

## Funcionalidades

### Site público

- Busca de quartos por data de entrada/saída e número de hóspedes
- Cálculo automático de disponibilidade em tempo real, considerando reservas ativas **e** períodos de manutenção
- Checkout com **Pix** (QR Code dinâmico) ou **cartão de crédito**, via Mercado Pago
- Tokenização de cartão feita no navegador — o número do cartão nunca trafega pelo servidor
- Aceite de termos (LGPD) obrigatório antes de finalizar a reserva
- Confirmação automática por e-mail e WhatsApp assim que o pagamento é aprovado
- Lembrete automático (e-mail + WhatsApp) um dia antes do check-in
- Progressive Web App (PWA) — instalável como aplicativo, com ícone e service worker próprios

### Painel administrativo

- Login protegido por usuário/senha com autenticação JWT
- Dashboard com faturamento e taxa de ocupação, filtrável por período
- Gráfico de evolução do faturamento dos últimos 12 meses
- Gestão completa de reservas: check-in, check-out, cancelamento, extensão de diária, edição de dados do hóspede
- Bloqueio manual de datas para reservas feitas no balcão/presencial
- **Gestão de manutenção por quarto:** cadastro de períodos (com motivo), visualização colorida no calendário de disponibilidade (vermelho = reservado, amarelo = manutenção), edição e remoção
- Envio de lembrete manual (e-mail + link direto de WhatsApp) para qualquer reserva
- Exportação em CSV de lista de clientes (leads) e relatório de faturamento (DRE)
- Calendário de disponibilidade por quarto, com legenda visual
- Interface com modais customizados (sem uso de `alert()`/`confirm()` nativos do navegador)

---

## Stack tecnológica

| Camada | Tecnologia | Uso |
|---|---|---|
| Backend | Node.js + Express 5 | API REST e servidor de arquivos estáticos |
| Banco de dados | PostgreSQL | Persistência de quartos, clientes, reservas e manutenções |
| Autenticação | JSON Web Token (JWT) + bcrypt | Login e proteção de rotas administrativas |
| Pagamentos | Mercado Pago SDK | Pix e cartão de crédito |
| E-mail transacional | API HTTP da Brevo | Confirmações e lembretes |
| WhatsApp | API HTTP do CallMeBot | Notificações automáticas e manuais |
| Segurança de headers | Helmet (CSP) | Content Security Policy contra XSS/clickjacking |
| Rate limiting | express-rate-limit | Proteção contra abuso da API |
| Agendamento | node-cron | Rotinas automáticas (lembretes, checkout, limpeza) |
| Frontend | HTML/CSS/JS puro | Sem framework — foco em simplicidade e performance |
| Calendários | Flatpickr | Seleção e visualização de datas |
| Gráficos | Chart.js | Gráfico de faturamento |
| Hospedagem | Render | Deploy automático a partir do `main` |

---

## Segurança

- Autenticação de administradores via **JWT**, com expiração de 8 horas, exigida em toda rota administrativa (`verificarPulseiraVIP`)
- Senhas de administrador armazenadas com hash **bcrypt** — nunca em texto puro
- Segredos (chaves de API, credenciais de banco, chave JWT) mantidos fora do código-fonte, via variáveis de ambiente
- Sanitização de entrada no servidor e escape de saída no painel, prevenindo **XSS**
- **Content Security Policy** (via Helmet), restringindo quais domínios podem carregar scripts, estilos e imagens
- **Rate limiting** nas rotas da API
- Consultas SQL 100% parametrizadas — sem concatenação de string em nenhuma query
- Verificação de pagamento feita diretamente com a API do Mercado Pago ao receber o webhook, sem confiar cegamente no payload recebido
- Tokenização de cartão feita no navegador via SDK oficial do Mercado Pago

---

## Estrutura do projeto

```
hospedaria-site/
├── server.js              # API completa (rotas públicas + administrativas)
├── package.json
├── .env.example           # Referência de variáveis de ambiente necessárias
└── public/
    ├── index.html          # Página inicial / busca
    ├── busca.html          # Resultados de disponibilidade
    ├── checkout.html        # Checkout (Pix / cartão)
    ├── admin.html          # Painel administrativo
    ├── login.html          # Login do admin
    ├── manifest.json       # Configuração do PWA
    ├── sw.js               # Service worker
    ├── css/
    └── images/
```

---

## Rotas da API

### Públicas

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/disponibilidade` | Datas ocupadas de um quarto (para o calendário) |
| `GET` | `/api/quartos-disponiveis` | Busca de quartos disponíveis por data/hóspedes |
| `GET` | `/api/reservas/:id/status` | Status de pagamento de uma reserva |
| `POST` | `/api/reservar` | Cria uma reserva (Pix) |
| `POST` | `/api/processar-cartao` | Processa pagamento com cartão |
| `POST` | `/api/webhook/mercadopago` | Webhook de confirmação de pagamento |

### Administrativas — protegidas por JWT

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/admin/login` | Autenticação, retorna o token |
| `GET` | `/api/admin/reservas` | Lista reservas ativas |
| `GET` | `/api/admin/dashboard` | Faturamento e ocupação do período |
| `GET` | `/api/admin/grafico-faturamento` | Série histórica de faturamento (12 meses) |
| `GET` | `/api/admin/exportar-leads` | Exporta lista de clientes |
| `GET` | `/api/admin/exportar-faturamento` | Exporta relatório de faturamento (DRE) |
| `POST` | `/api/admin/bloquear` | Bloqueio manual de data (balcão) |
| `PUT` | `/api/admin/reservas/:id/efetivar` | Edita dados do hóspede |
| `DELETE` | `/api/admin/reservas/:id` | Cancela uma reserva |
| `PUT` | `/api/admin/reservas/:id/checkin` | Registra check-in |
| `PUT` | `/api/admin/reservas/:id/checkout` | Registra check-out |
| `POST` | `/api/admin/reservas/:id/estender` | Estende a diária em +1 dia |
| `POST` | `/api/admin/reservas/:id/lembrete` | Dispara lembrete manual |
| `GET` | `/api/admin/manutencoes` | Lista períodos de manutenção |
| `POST` | `/api/admin/quarto/manutencao` | Cadastra período de manutenção |
| `PUT` | `/api/admin/quarto/manutencao/:id` | Edita período de manutenção |
| `DELETE` | `/api/admin/quarto/manutencao/:id` | Remove período de manutenção |

---

## Automações (cron jobs)

| Frequência | Rotina |
|---|---|
| Diariamente às 08h | Envia lembrete (e-mail) para check-ins do dia seguinte |
| Diariamente às 13h | Auto-checkout de reservas com data de saída vencida |
| A cada 5 minutos | Cancela reservas pendentes de pagamento há mais de 30 minutos |

---

## Como rodar localmente

```bash
# Clonar o repositório
git clone <url-do-repositorio>
cd hospedaria-site

# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env
# preencher o .env com suas próprias credenciais

# Rodar
npm start
```

O servidor sobe por padrão na porta `3000` (configurável via `PORT`).

---

## Testes

```bash
npm test
```

Cobre hoje os pontos mais sensíveis da aplicação: a rota de login administrativo (`/api/admin/login`) e o cálculo de preço das diárias (função pura `calcularDiaria` e as rotas `/api/quartos-disponiveis` e `/api/admin/calcular-diaria`, que dependem dela). O banco de dados é mockado (`jest.mock('pg')`) — os testes não tocam no Postgres real e rodam em segundos.

---

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String de conexão do PostgreSQL |
| `JWT_SECRET` | Chave secreta para assinatura dos tokens de admin |
| `SENHA_MARCUS` / `SENHA_KLESSIA` | Senhas iniciais dos usuários administradores |
| `MP_ACCESS_TOKEN` | Token de acesso do Mercado Pago |
| `BREVO_API_KEY` | Chave da API da Brevo (e-mail transacional) |
| `EMAIL_USER` | E-mail remetente das notificações |
| `CALLMEBOT_PHONE` / `CALLMEBOT_APIKEY` | Credenciais do CallMeBot (WhatsApp) |
| `PORT` | Porta do servidor (opcional, padrão `3000`) |

Veja `.env.example` para o modelo completo.

---

## Deploy

O deploy é automático: qualquer `push` na branch `main` dispara um novo build e deploy no [Render](https://render.com). As variáveis de ambiente de produção são configuradas diretamente no painel do Render, não a partir do `.env` local.

---

## Roadmap

Itens identificados para próximas iterações:

- [x] Rate limiting dedicado na rota de login
- [x] Centralizar a tabela de preços por quarto em um único lugar
- [ ] Modularizar `server.js` em arquivos por domínio (reservas, admin, pagamento)
- [ ] Testes automatizados (começado: login e cálculo de preço já cobertos, falta o restante das rotas)
- [x] SEO básico (meta description, Open Graph, sitemap.xml)

---

## Licença

Projeto privado — todos os direitos reservados.