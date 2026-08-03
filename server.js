require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. Conexão com o PostgreSQL (Compatível com Neon/Render e Local)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 2. Mercado Pago Config & Instância Payment
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});
const payment = new Payment(client);

// 3. Tabela de Preços por Hóspedes e Tipo de Quarto
function calcularDiaria(quartoId, hospedes) {
    const numHospedes = parseInt(hospedes) || 1;
    const idQuarto = parseInt(quartoId);

    // Suíte Master (Quarto 3)
    if (idQuarto === 3) {
        if (numHospedes === 1) return 100.00;
        if (numHospedes === 2) return 150.00;
        if (numHospedes === 3) return 200.00;
    } 
    // Quartos Padrão (1, 2, 4 e futuros)
    else {
        if (numHospedes === 1) return 75.00;
        if (numHospedes === 2) return 130.00;
        if (numHospedes === 3) return 180.00;
    }
    return 75.00;
}

/* ==========================================================================
   ROTAS PÚBLICAS (SITE DE CLIENTES)
   ========================================================================== */

// ROTA 1: Buscar dias ocupados para o calendário do Modal da Home
app.get('/api/disponibilidade', async (req, res) => {
    const { quartoId, mes, ano } = req.query;

    try {
        const reservas = await pool.query(
            `SELECT data_checkin, data_checkout FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao')
             AND EXTRACT(MONTH FROM data_checkin) = $2 
             AND EXTRACT(YEAR FROM data_checkin) = $3`,
            [quartoId, mes, ano]
        );

        res.json({ diasOcupados: reservas.rows });
    } catch (err) {
        console.error("Erro na rota de disponibilidade:", err);
        res.status(500).json({ erro: 'Erro ao buscar disponibilidade do calendário.' });
    }
});

// ROTA 2: Busca de Quartos Disponíveis (Para busca.html)
app.get('/api/quartos-disponiveis', async (req, res) => {
    const { start, end, adults } = req.query;

    if (!start || !end) {
        return res.status(400).json({ erro: 'Parâmetros de data inválidos.' });
    }

    try {
        const numHospedes = parseInt(adults) || 1;

        const query = `
            SELECT q.* 
            FROM quartos q
            WHERE q.ativo = TRUE 
            AND q.capacidade_maxima >= $1
            AND q.id NOT IN (
                SELECT quarto_id 
                FROM reservas 
                WHERE status_pagamento IN ('pago', 'bloqueado_balcao')
                AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)
            )
            ORDER BY q.id ASC;
        `;

        const result = await pool.query(query, [numHospedes, start, end]);

        const dCheckin = new Date(`${start}T00:00:00`);
        const dCheckout = new Date(`${end}T00:00:00`);
        const diffTempo = dCheckout.getTime() - dCheckin.getTime();
        const dias = Math.ceil(diffTempo / (1000 * 3600 * 24)) || 1;

        const quartosComPreco = result.rows.map(quarto => {
            const valorDiaria = calcularDiaria(quarto.id, numHospedes);
            return {
                ...quarto,
                diasReservados: dias,
                valorDiaria: valorDiaria,
                valorTotal: dias * valorDiaria
            };
        });

        res.json({ disponiveis: quartosComPreco });

    } catch (err) {
        console.error("Erro na busca de quartos:", err);
        res.status(500).json({ erro: 'Erro interno ao buscar quartos.' });
    }
});

// ROTA 3: Criar Reserva do Site e Cobrança Pix via Mercado Pago
app.post('/api/reservar', async (req, res) => {
    const { quartoId, hospedes, cliente, checkin, checkout } = req.body;

    try {
        const checkQuarto = await pool.query('SELECT ativo FROM quartos WHERE id = $1', [quartoId]);
        if (checkQuarto.rows.length === 0 || !checkQuarto.rows[0].ativo) {
            return res.status(400).json({ erro: 'Quarto indisponível no momento.' });
        }

        // Bloqueia se já houver reserva paga OU bloqueio de balcão
        const conflito = await pool.query(
            `SELECT * FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Quarto já reservado ou indisponível nestas datas!' });
        }

        let clienteResult = await pool.query('SELECT id FROM clientes WHERE cpf = $1', [cliente.cpf]);
        let clienteId;

        if (clienteResult.rows.length === 0) {
            const novoCliente = await pool.query(
                'INSERT INTO clientes (nome, cpf, telefone, email) VALUES ($1, $2, $3, $4) RETURNING id',
                [cliente.nome, cliente.cpf, cliente.telefone, cliente.email || 'contato@hospedariacentral.com.br']
            );
            clienteId = novoCliente.rows[0].id;
        } else {
            clienteId = clienteResult.rows[0].id;
        }

        const dCheckin = new Date(`${checkin}T00:00:00`);
        const dCheckout = new Date(`${checkout}T00:00:00`);
        const dias = Math.ceil((dCheckout.getTime() - dCheckin.getTime()) / (1000 * 3600 * 24));

        if (dias <= 0) {
            return res.status(400).json({ erro: 'Data de saída deve ser posterior à data de entrada.' });
        }

        const valorDiaria = calcularDiaria(quartoId, hospedes);
        const valorTotal = dias * valorDiaria;

        const mpResponse = await payment.create({
            body: {
                transaction_amount: valorTotal,
                description: `Hospedaria Central - Quarto ${quartoId} (${hospedes} pessoa(s))`,
                payment_method_id: 'pix',
                payer: {
                    email: cliente.email || 'contato@hospedariacentral.com.br',
                    first_name: cliente.nome,
                    identification: { type: 'CPF', number: cliente.cpf.replace(/\D/g, '') }
                }
            }
        });

        const novaReserva = await pool.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7) RETURNING id`,
            [quartoId, clienteId, hospedes, checkin, checkout, valorTotal, String(mpResponse.id)]
        );

        res.json({
            reservaId: novaReserva.rows[0].id,
            pixCopiaECola: mpResponse.point_of_interaction.transaction_data.qr_code,
            qrCodeBase64: mpResponse.point_of_interaction.transaction_data.qr_code_base64,
            valorTotal: valorTotal
        });

    } catch (err) {
        console.error("Erro ao criar reserva:", err);
        res.status(500).json({ erro: 'Erro interno ao criar reserva.' });
    }
});

// ROTA 4: Webhook para confirmação automática do Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
    const { type, data } = req.body;
    try {
        if (type === 'payment' && data?.id) {
            const pagamentoInfo = await payment.get({ id: data.id });
            if (pagamentoInfo.status === 'approved') {
                await pool.query("UPDATE reservas SET status_pagamento = 'pago' WHERE mp_payment_id = $1", [String(data.id)]);
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error("Erro no Webhook:", err);
        res.sendStatus(500);
    }
});

/* ==========================================================================
   ROTAS ADMINISTRATIVAS (PAINEL DO CELULAR)
   ========================================================================== */

// ROTA ADMIN 1: Listar todas as ocupações ativas
app.get('/api/admin/reservas', async (req, res) => {
    try {
        const query = `
            SELECT r.id, r.quarto_id, q.numero_quarto, c.nome AS cliente_nome, c.telefone,
                   r.data_checkin, r.data_checkout, r.status_pagamento, r.valor_total
            FROM reservas r
            JOIN quartos q ON q.id = r.quarto_id
            LEFT JOIN clientes c ON c.id = r.cliente_id
            WHERE r.status_pagamento IN ('pago', 'bloqueado_balcao')
            ORDER BY r.data_checkin ASC;
        `;
        const result = await pool.query(query);
        res.json({ reservas: result.rows });
    } catch (err) {
        console.error("Erro ao buscar reservas admin:", err);
        res.status(500).json({ erro: 'Erro ao carregar reservas.' });
    }
});

// ROTA ADMIN 2: Travar/Bloquear datas presencialmente (Balcão)
app.post('/api/admin/bloquear', async (req, res) => {
    const { quartoId, checkin, checkout } = req.body;

    try {
        const conflito = await pool.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Já existe reserva ou bloqueio para esta data!' });
        }

        await pool.query(
            `INSERT INTO reservas (quarto_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento) 
             VALUES ($1, 1, $2, $3, 0.00, 'bloqueado_balcao')`,
            [quartoId, checkin, checkout]
        );

        res.json({ mensagem: 'Data bloqueada com sucesso!' });
    } catch (err) {
        console.error("Erro ao bloquear data:", err);
        res.status(500).json({ erro: 'Erro interno ao salvar bloqueio.' });
    }
});

// ROTA ADMIN 3: Cancelar Reserva ou Desbloquear Data
app.delete('/api/admin/reservas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE reservas SET status_pagamento = 'cancelado' WHERE id = $1", [id]);
        res.json({ mensagem: 'Reserva/Bloqueio removido com sucesso.' });
    } catch (err) {
        console.error("Erro ao cancelar reserva:", err);
        res.status(500).json({ erro: 'Erro ao remover reserva.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));