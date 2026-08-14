require('dotenv').config();
const express = require('express');
const https = require('https');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: { rejectUnauthorized: false }
});

const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});
const payment = new Payment(mpClient);

function calcularDiaria(quartoId: any, hospedes: any): number {
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

// ROTA: PROCESSAR PAGAMENTO COM CARTÃO
app.post('/api/processar-cartao', async (req: any, res: any) => {
    try {
        const { token, paymentMethodId, issuerId, installments, email, description, amount, reservaId } = req.body;

        const paymentResponse = await payment.create({
            body: {
                token,
                payment_method_id: paymentMethodId,
                transaction_amount: Number(amount),
                installments: Number(installments || 1),
                issuer_id: issuerId ? Number(issuerId) : undefined,
                description,
                payer: { email: email || 'contato@hospedariacentral.com.br' }
            }
        });

        if (paymentResponse.status === 'approved') {
            await pool.query("UPDATE reservas SET status_pagamento = 'pago', mp_payment_id = $1 WHERE id = $2", 
                [String(paymentResponse.id), reservaId]);
        } else {
            await pool.query("UPDATE reservas SET mp_payment_id = $1 WHERE id = $2", 
                [String(paymentResponse.id), reservaId]);
        }

        return res.json({ 
            sucesso: true, 
            status: paymentResponse.status,
            paymentId: paymentResponse.id 
        });
    } catch (error: any) {
        console.error('ERRO AO PROCESSAR CARTÃO:', error);
        return res.status(400).json({ erro: error.message || 'Erro ao processar pagamento com cartão.' });
    }
});

// ROTAS PÚBLICAS
app.get('/api/disponibilidade', async (req: any, res: any) => {
    const { quartoId } = req.query;
    if (!quartoId) return res.status(400).json({ erro: 'Parâmetro quartoId é obrigatório.' });

    try {
        const reservas = await pool.query(
            `SELECT data_checkin, data_checkout FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
             ORDER BY data_checkin ASC`,
            [quartoId]
        );
        return res.json({ diasOcupados: reservas.rows });
    } catch (err) {
        return res.status(500).json({ erro: 'Erro ao buscar disponibilidade.' });
    }
});

app.get('/api/quartos-disponiveis', async (req: any, res: any) => {
    const { start, end, adults } = req.query;
    if (!start || !end) return res.status(400).json({ erro: 'Parâmetros de data inválidos.' });

    try {
        const numHospedes = parseInt(adults) || 1;
        const query = `
            SELECT q.* FROM quartos q
            WHERE q.ativo = TRUE AND q.capacidade_maxima >= $1
            AND q.id NOT IN (
                SELECT quarto_id FROM reservas 
                WHERE status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
                AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)
            ) ORDER BY q.id ASC;
        `;
        const result = await pool.query(query, [numHospedes, start, end]);

        const dCheckin = new Date(`${start}T00:00:00`);
        const dCheckout = new Date(`${end}T00:00:00`);
        const dias = Math.ceil((dCheckout.getTime() - dCheckin.getTime()) / (1000 * 3600 * 24)) || 1;

        const quartosComPreco = result.rows.map(quarto => {
            const valorDiaria = calcularDiaria(quarto.id, numHospedes);
            return { ...quarto, diasReservados: dias, valorDiaria, valorTotal: dias * valorDiaria };
        });

        return res.json({ disponiveis: quartosComPreco });
    } catch (err) {
        return res.status(500).json({ erro: 'Erro interno ao buscar quartos.' });
    }
});

app.post('/api/reservar', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
        const { quartoId, hospedes, cliente, checkin, checkout } = req.body;
        if (!quartoId || !cliente || !checkin || !checkout) {
            return res.status(400).json({ erro: 'Dados incompletos para a reserva.' });
        }

        const conflito = await client.query(
            `SELECT id FROM reservas WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Quarto já reservado ou indisponível nestas datas!' });
        }

        await client.query('BEGIN');
        const cpfLimpo = cliente.cpf ? cliente.cpf.replace(/\D/g, '') : '';
        const cpfFinal = cpfLimpo.length > 0 ? cpfLimpo : `SEM-CPF-${Date.now()}`;

        let clienteRes = await client.query('SELECT id FROM clientes WHERE telefone = $1', [cliente.telefone]);
        let clienteId;

        if (clienteRes.rows.length > 0) {
            clienteId = clienteRes.rows[0].id;
        } else {
            const novoCliente = await client.query(
                'INSERT INTO clientes (nome, cpf, telefone, email) VALUES ($1, $2, $3, $4) RETURNING id',
                [cliente.nome, cpfFinal, cliente.telefone, cliente.email || 'cliente@hospedariacentral.com.br']
            );
            clienteId = novoCliente.rows[0].id;
        }

        const dias = Math.ceil((new Date(`${checkout}T00:00:00`).getTime() - new Date(`${checkin}T00:00:00`).getTime()) / (1000 * 60 * 60 * 24));
        if (dias <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Data de saída deve ser posterior à data de entrada.' });
        }

        const valorTotal = dias * calcularDiaria(quartoId, hospedes);

        const paymentResponse = await payment.create({
            body: {
                transaction_amount: Number(valorTotal),
                description: `Reserva Quarto ${quartoId} - Hospedaria Central`,
                payment_method_id: 'pix',
                payer: { email: cliente.email || 'cliente@hospedariacentral.com.br', first_name: cliente.nome }
            }
        });

        const reservaRes = await client.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, $3, $4::date, $5::date, $6, 'pendente', $7) RETURNING id`,
            [quartoId, clienteId, hospedes || 1, checkin, checkout, valorTotal, String(paymentResponse.id)]
        );

        await client.query('COMMIT');

        // AVISO WHATSAPP SEGURO
        try {
            const urlWpp = `https://api.callmebot.com/whatsapp.php?phone=556484594781&text=${encodeURIComponent(`🔔 *Nova Reserva!*\nQuarto: 0${quartoId}\nCliente: ${cliente.nome}\nData: ${checkin} a ${checkout}\nValor: R$ ${valorTotal.toFixed(2)}`)}&apikey=5774787`;
            https.get(urlWpp, (r: any) => r.on('data', () => {}));
        } catch (e) {}

        return res.json({
            sucesso: true,
            reservaId: reservaRes.rows[0].id,
            pixCopiaECola: paymentResponse.point_of_interaction.transaction_data.qr_code,
            qrCodeBase64: paymentResponse.point_of_interaction.transaction_data.qr_code_base64,
            valorTotal
        });
    } catch (error) {
        await client.query('ROLLBACK');
        return res.status(500).json({ erro: 'Erro interno ao criar reserva.' });
    } finally {
        client.release();
    }
});

// WEBHOOK
app.post('/api/webhook/mercadopago', async (req: any, res: any) => {
    const { type, data } = req.body;
    try {
        if (type === 'payment' && data?.id) {
            const pInfo = await payment.get({ id: data.id });
            if (pInfo.status === 'approved') {
                await pool.query("UPDATE reservas SET status_pagamento = 'pago' WHERE mp_payment_id = $1", [String(data.id)]);
            }
        }
        return res.sendStatus(200);
    } catch (err) {
        return res.sendStatus(500);
    }
});

// ROTAS ADMIN BÁSICAS
app.get('/api/admin/reservas', async (req: any, res: any) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.quarto_id, q.numero_quarto, r.quantidade_hospedes,
                   COALESCE(c.nome, 'Balcão') AS cliente_nome, COALESCE(c.telefone, 'Sem Telefone') AS telefone,
                   r.data_checkin, r.data_checkout, r.status_pagamento, r.valor_total
            FROM reservas r JOIN quartos q ON q.id = r.quarto_id LEFT JOIN clientes c ON c.id = r.cliente_id
            WHERE r.status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin') ORDER BY r.data_checkin ASC;
        `);
        return res.json({ reservas: result.rows });
    } catch (err) {
        return res.status(500).json({ erro: 'Erro ao carregar reservas.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));