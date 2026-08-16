# 🏨 Hospedaria Central — Sistema de Gestão & Reservas

> Sistema web full-stack desenvolvido sob medida para a **Hospedaria Central**, localizado no coração de Morrinhos (GO). Uma solução completa que integra um portal público de reservas automatizadas via Pix e Cartões de Crédito e Débito com um painel administrativo voltado para a alta performance operacional da gestão hoteleira.

---

## 🚀 Diferenciais do Projeto & Visão de Negócio

* **Gestão Ágil Mobile-First:** Desenvolvido pensando na rotina real de operação, contando com um painel responsivo adaptado para toque ("Modo Klessia") para agilizar check-ins, check-outs e bloqueios rápidos pelo celular.
* **Progressive Web App (PWA):** O sistema se comporta como um aplicativo nativo. Pode ser instalado diretamente na tela inicial do celular do gestor, rodando em tela cheia e sem barras de navegação.
* **Matéria de Datas Inteligente (Dia Compartilhado):** O motor de reservas gerencia transições fluidas de hóspedes no mesmo dia (permitindo check-out pela manhã e check-in à tarde no mesmo quarto).
* **Segurança e Blindagem Ativa:** Servidor protegido com limitação de requisições por IP (*Rate Limiting*) para mitigar ataques de força bruta e robôs, além de rotas blindadas contra acessos não autorizados.

---

## 🛠️ Tecnologias Utilizadas

Este projeto foi construído utilizando tecnologias modernas de mercado, focando em robustez, escalabilidade e manutenibilidade:

* **Backend:** Node.js, Express.js
* **Banco de Dados Relacional:** PostgreSQL (com conexões parametrizadas e controle transacional via `pg` pool)
* **Frontend:** HTML5, CSS3 Customizado (Design System próprio), JavaScript Vanilla (ES6+)
* **Integrações de Pagamento:** API do Mercado Pago (Geração de Pix automatizada)
* **Ferramentas e Padrões:** Git/GitHub, PWA (Service Workers, Web App Manifest), Flatpickr (Calendários dinâmicos)

---

## 📂 Arquitetura do Projeto

```text
hospedaria-site/
├── public/                # Arquivos estáticos do Frontend
│   ├── css/               # Estilos modularizados (global.css, home.css, admin.css)
│   ├── images/            # Identidade visual e mídias das acomodações
│   ├── js/                # Scripts de interação e consumo de rotas
│   ├── admin.html         # Painel administrativo de controle de leitos
│   ├── login.html         # Tela de autenticação restrita
│   ├── manifest.json      # Configuração do PWA (Aplicativo mobile)
│   └── sw.js              # Service Worker para cache e ciclo de vida do app
├── server.js              # Servidor principal (API REST, rotas e regras de negócio)
├── package.json           # Dependências e scripts do Node.js
└── README.md              # Documentação oficial do projeto
⚙️ Principais Funcionalidades
Canal de Reservas Direto (Público):

Consulta de vagas em tempo real com calendário integrado.

Cálculo automático de diárias e valor total com base no número de hóspedes e tipo de acomodação.

Geração instantânea de pagamento via Pix.

Painel Administrativo Restrito (Privado):

Visão geral de ocupação e faturamento.

Controles rápidos para marcação de Check-in, Check-out, cancelamentos e bloqueios manuais de balcão.

Tratamento de conflitos de datas integrado ao banco de dados PostgreSQL.

💻 Como Executar o Projeto Localmente
Se você deseja clonar e rodar este repositório em sua máquina de desenvolvimento:

Clone o repositório:

Bash
git clone [https://github.com/SEU-USUARIO/hospedaria-site.git](https://github.com/SEU-USUARIO/hospedaria-site.git)
cd hospedaria-site
Instale as dependências:

Bash
npm install
Configure as Variáveis de Ambiente:
Crie um arquivo .env na raiz do projeto contendo as credenciais do seu banco de dados PostgreSQL e as chaves da API de pagamento:

Snippet de código
DATABASE_URL=sua_string_de_conexao_postgres
PORT=3000
MP_ACCESS_TOKEN=seu_token_mercado_pago
Inicie o servidor:

Bash
npm run dev
👨‍💻 Desenvolvedor
Desenvolvido por Marcus Vinicius Abdalla Teixeira e Silva.

Administrador de Empresas e Estudante de Análise e Desenvolvimento de Sistemas.