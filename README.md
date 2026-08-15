# 🏨 Hospedaria Central Morrinhos — Sistema Completo de Gestão e Reservas

Plataforma Web Full Stack desenvolvida do zero para automação do fluxo de reservas, verificação de disponibilidade em tempo real, geração de pagamentos via Pix com webhook de confirmação automática e painel administrativo mobile-first para gestão de balcão.

---

## 🎯 Sobre O Projeto

O projeto foi concebido para resolver o problema de gestão de vagas de uma hospedaria localizada em frente a um polo hospitalar em Morrinhos-GO. O objetivo principal foi substituir o controle manual por uma solução digital resiliente, capaz de prevenir o overbooking, automatizar cobranças e oferecer uma experiência fluida tanto para o cliente final quanto para a equipe operacional.

---

## 🛠️ Arquitetura e Tecnologias

### Backend
* **Node.js & Express.js:** Construção de REST API com roteamento modular e middleware de arquivos estáticos.
* **PostgreSQL (Neon Cloud):** Banco de dados relacional distribuído em nuvem com suporte a conexões seguras via TLS/SSL.
* **Mercado Pago SDK v2:** Integração nativa para emissão de cobranças Pix (Copiar e Cola e QR Code Base64), processamento de cartões e consumo de Webhooks para atualização em tempo real do status das reservas.

### Frontend
* **Vanilla JavaScript (ES6+):** Consumo assíncrono das APIs locais usando `fetch`, gerenciamento do DOM e manipulação de querystrings via `URLSearchParams`.
* **Flatpickr:** Componente avançado de seleção de datas customizado para bloqueio dinâmico de intervalos indisponíveis e prevenção de inconsistências temporais (fuso horário).
* **HTML5 / CSS3:** Layout responsivo com CSS Variables, alinhado à identidade visual da marca (Terracota & Marrom Café).

---

## ⚡ Diferenciais Técnicos e Arquitetura de Dados

### 1. Prevenção de Overbooking no Banco de Dados
A consulta de checagem de disponibilidade utiliza o operador de sobreposição de datas do PostgreSQL (`OVERLAPS`), garantindo atomicidade e performance superior no nível de banco de dados:
```sql
SELECT q.* FROM quartos q 
WHERE q.ativo = TRUE 
  AND q.capacidade_maxima >= $1
  AND q.id NOT IN (
      SELECT quarto_id 
      FROM reservas 
      WHERE status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
        AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)
  ) 
ORDER BY q.id ASC;
2. Estrutura Dinâmica de Tarifas
O cálculo de diárias e totais é processado no servidor por meio de uma função especialista, blindando a lógica financeira contra alterações maliciosas no cliente:

Quartos Padrão: Escalonamento por quantidade de hóspedes (1, 2 ou 3 pessoas).

Suíte Master: Precificação diferenciada baseada no perfil da acomodação.

3. Tratamento Avançado de Datas e Fusos Horários
A captura das datas no cliente lida diretamente com o Timezone Offset para evitar a perda de um dia decorrente da conversão para UTC no toISOString():

JavaScript
const offsetMs = selectedDates[0].getTimezoneOffset() * 60000;
const dateString = new Date(selectedDates[0].getTime() - offsetMs).toISOString().split('T')[0];
4. Gestão Robusta de Estados e Constraints (Check-in/Checkout)
Validação rígida no banco de dados através de CHECK CONSTRAINT na tabela de reservas, contemplando o ciclo completo de atendimento: pendente, pago, cancelado, bloqueado_balcao, concluido, checkin e checkout.

📂 Estrutura do Repositório
Plaintext
hospedaria-site/
├── public/                # Camada Frontend (Static Web Server)
│   ├── images/            # Assets visuais otimizados
│   ├── admin.html         # Painel administrativo mobile-first
│   ├── busca.html         # Tela de resultados e checkout Pix
│   ├── index.html         # Landing page institucional com busca rápida
│   └── style.css          # Design System e regras de UI
├── backup/                # Repositório de segurança e versões legadas
├── .env                   # Variáveis de ambiente (Local - ignorado no Git)
├── .gitignore             # Proteção de credenciais e dependências
├── package.json           # Manifesto de dependências do Node.js
└── server.js              # Entrypoint da API Node.js e rotas de negócio
🔌 Rotas da API
Rotas Públicas e de Cliente
Método	Rota	Descrição
GET	/api/disponibilidade	Retorna datas ocupadas de um quarto para exibição no calendário.
GET	/api/quartos-disponiveis	Filtra quartos livres por período e capacidade máxima.
POST	/api/reservar	Cria pré-reserva, gera cobrança Pix no Mercado Pago e retorna o QR Code.
POST	/api/processar-cartao	Processa pagamentos via cartão de crédito de forma transacional.
POST	/api/webhook/mercadopago	Endpoint seguro para confirmação automática via Mercado Pago.
Rotas Administrativas
Método	Rota	Descrição
GET	/api/admin/reservas	Lista todas as reservas ativas, bloqueios e estados de check-in.
POST	/api/admin/bloquear	Permite travar datas no balcão sem emissão de cobrança.
DELETE	/api/admin/reservas/:id	Libera datas e cancela registros de ocupação.
🔧 Como Executar o Projeto Localmente
Pré-requisitos
Node.js (v18+)

PostgreSQL instalado ou instância no Neon / Supabase.

Passo a Passo
Clone o repositório:

Bash
git clone [https://github.com/MarcusViniciusAbdalla/hospedaria-site.git](https://github.com/MarcusViniciusAbdalla/hospedaria-site.git)
cd hospedaria-site
Instale as dependências:

Bash
npm install
Configure as Variáveis de Ambiente:
Crie um arquivo .env na raiz do projeto com o seguinte formato:

Snippet de código
PORT=3000
DATABASE_URL=postgresql://usuario:senha@host:5432/nomedobanco?sslmode=require
MP_ACCESS_TOKEN=APP_USR-seu-access-token-aqui
Inicie o servidor de desenvolvimento:

Bash
npm start
O servidor iniciará em http://localhost:3000

🌐 Deploy em Produção
O projeto foi implantado utilizando integração contínua (CI/CD) automatizada via GitHub e plataformas de nuvem serverless:

Aplicação (Backend/Frontend): Render Cloud Services

Database Relacional: Neon PostgreSQL

Gateway de Pagamento: Mercado Pago Developers

👨‍💻 Desenvolvedor
Marcus Vinicius Abdalla Teixeira e Silva

Desenvolvedor Full Stack & Administrador

LinkedIn | GitHub