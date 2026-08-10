require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. Conexão com o PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: { rejectUnauthorized: false }
});

// 2. Mercado Pago Config
const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});
const payment = new Payment(mpClient);

// 3. Tabela de Preços
function calcularDiaria(quartoId, hospedes) {
    const numHospedes = parseInt(hospedes) || 1;
    const idQuarto = parseInt(quartoId);

    if (idQuarto === 3) {
        if (numHospedes === 1) return 100.00;
        if (numHospedes === 2) return 150.00;
        if (numHospedes === 3) return 200.00;
    } else {
        if (numHospedes === 1) return 75.00;
        if (numHospedes === 2) return 130.00;
        if (numHospedes === 3) return 180.00;
    }
    return 75.00;
}

/* ==========================================================================
   ROTAS PÚBLICAS
   ========================================================================== */

app.get('/api/disponibilidade', async (req, res) => {
    const { quartoId } = req.query;

    if (!quartoId) {
        return res.status(400).json({ erro: 'Parâmetro quartoId é obrigatório.' });
    }

    try {
        const reservas = await pool.query(
            `SELECT data_checkin, data_checkout FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido')
             ORDER BY data_checkin ASC`,
            [quartoId]
        );

        res.json({ diasOcupados: reservas.rows });
    } catch (err) {
        console.error("Erro na rota de disponibilidade:", err);
        res.status(500).json({ erro: 'Erro ao buscar disponibilidade.' });
    }
});

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
                WHERE status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido')
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

app.post('/api/reservar', async (req, res) => {
    const client = await pool.connect();
    try {
        const { quartoId, hospedes, cliente, checkin, checkout } = req.body;

        if (!quartoId || !cliente || !checkin || !checkout) {
            return res.status(400).json({ erro: 'Dados incompletos para a reserva.' });
        }

        const conflito = await client.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Quarto já reservado ou indisponível nestas datas!' });
        }

        await client.query('BEGIN');

        const cpfLimpo = cliente.cpf ? cliente.cpf.replace(/\D/g, '') : '';
        let clienteRes = await client.query('SELECT id FROM clientes WHERE cpf = $1 AND cpf != \'\'', [cpfLimpo]);
        let clienteId;

        if (clienteRes.rows.length > 0) {
            clienteId = clienteRes.rows[0].id;
        } else {
            const novoCliente = await client.query(
                'INSERT INTO clientes (nome, cpf, telefone, email) VALUES ($1, $2, $3, $4) RETURNING id',
                [cliente.nome, cpfLimpo, cliente.telefone, cliente.email || 'contato@hospedariacentral.com.br']
            );
            clienteId = novoCliente.rows[0].id;
        }

        const d1 = new Date(`${checkin}T00:00:00`);
        const d2 = new Date(`${checkout}T00:00:00`);
        const dias = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
        
        if (dias <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Data de saída deve ser posterior à data de entrada.' });
        }

        const valorDiaria = calcularDiaria(quartoId, hospedes);
        const valorTotal = dias * valorDiaria;

        const paymentResponse = await payment.create({
            body: {
                transaction_amount: Number(valorTotal),
                description: `Reserva Quarto ${quartoId} - Hospedaria Central`,
                payment_method_id: 'pix',
                payer: {
                    email: cliente.email || 'contato@hospedariacentral.com.br',
                    first_name: cliente.nome,
                    identification: { type: 'CPF', number: cpfLimpo }
                }
            }
        });

        const reservaRes = await client.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, $3, $4::date, $5::date, $6, 'pendente', $7) RETURNING id`,
            [quartoId, clienteId, hospedes || 1, checkin, checkout, valorTotal, String(paymentResponse.id)]
        );

        await client.query('COMMIT');

        res.json({
            sucesso: true,
            reservaId: reservaRes.rows[0].id,
            pixCopiaECola: paymentResponse.point_of_interaction.transaction_data.qr_code,
            qrCodeBase64: paymentResponse.point_of_interaction.transaction_data.qr_code_base64,
            valorTotal: valorTotal
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERRO DETALHADO NA RESERVA:', error);
        res.status(500).json({ erro: 'Erro interno ao criar reserva.' });
    } finally {
        client.release();
    }
});

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
   ROTAS ADMINISTRATIVAS
   ========================================================================== */

app.get('/api/admin/reservas', async (req, res) => {
    try {
        const query = `
            SELECT r.id, r.quarto_id, q.numero_quarto, 
                   COALESCE(c.nome, 'Atendimento Presencial / Balcão') AS cliente_nome, 
                   COALESCE(c.telefone, 'Sem Telefone') AS telefone,
                   r.data_checkin, r.data_checkout, r.status_pagamento, r.valor_total
            FROM reservas r
            JOIN quartos q ON q.id = r.quarto_id
            LEFT JOIN clientes c ON c.id = r.cliente_id
            WHERE r.status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido')
            ORDER BY r.data_checkin ASC;
        `;
        const result = await pool.query(query);
        res.json({ reservas: result.rows });
    } catch (err) {
        console.error("Erro ao buscar reservas admin:", err);
        res.status(500).json({ erro: 'Erro ao carregar reservas.' });
    }
});

// ROTA ADMIN: Bloquear com inserção segura de cliente sem conflito de CPF
app.post('/api/admin/bloquear', async (req, res) => {
    const { quartoId, checkin, checkout, valorTotal, cliente } = req.body;

    if (!quartoId || !checkin || !checkout) {
        return res.status(400).json({ erro: "Selecione o quarto e as datas para bloqueio." });
    }

    try {
        const conflito = await pool.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Já existe reserva ou bloqueio para esta data!' });
        }

        // Gera um identificador único temporário para evitar duplicidade de CPF no banco
        const cpfUnicoBalcao = `BALCAO-${Date.now()}`;
        
        const novoCliente = await pool.query(
            `INSERT INTO clientes (nome, cpf, telefone, email) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id`,
            [
                cliente?.nome || 'Atendimento Presencial / Balcão',
                cpfUnicoBalcao,
                cliente?.telefone || '(64) 00000-0000',
                cliente?.email || 'balcao@hospedariacentral.com.br'
            ]
        );
        
        const clienteId = novoCliente.rows[0].id;
        const valorSalvar = parseFloat(valorTotal) || 0.00;

        await pool.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, 1, $3::date, $4::date, $5, 'bloqueado_balcao', 'balcao_presencial')`,
            [quartoId, clienteId, checkin, checkout, valorSalvar]
        );

        res.json({ mensagem: 'Bloqueio e lead salvos com sucesso!' });

    } catch (err) {
        console.error("Erro detalhado ao salvar bloqueio:", err);
        res.status(500).json({ erro: 'Erro interno ao salvar no banco.' });
    }
});

app.put('/api/admin/reservas/:id/efetivar', async (req, res) => {
    const { id } = req.params;
    const { nome, telefone } = req.body;

    try {
        const resReserva = await pool.query("SELECT cliente_id FROM reservas WHERE id = $1", [id]);
        if (resReserva.rows.length === 0) return res.status(404).json({ erro: "Reserva não encontrada." });

        const clienteId = resReserva.rows[0].cliente_id;

        await pool.query("UPDATE clientes SET nome = $1, telefone = $2 WHERE id = $3", [nome, telefone, clienteId]);
        await pool.query("UPDATE reservas SET status_pagamento = 'concluido' WHERE id = $1", [id]);

        res.json({ mensagem: 'Reserva efetivada com sucesso!' });
    } catch (err) {
        console.error("Erro ao efetivar reserva:", err);
        res.status(500).json({ erro: 'Erro ao efetivar reserva.' });
    }
});

app.delete('/api/admin/reservas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE reservas SET status_pagamento = 'cancelado' WHERE id = $1", [id]);
        res.json({ mensagem: 'Reserva cancelada e data liberada com sucesso.' });
    } catch (err) {
        console.error("Erro ao cancelar reserva:", err);
        res.status(500).json({ erro: 'Erro ao remover reserva.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));