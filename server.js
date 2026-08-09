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
const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});
const payment = new Payment(mpClient);

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

// ROTA 1: Buscar dias ocupados para os calendários do Modal e do Admin
app.get('/api/disponibilidade', async (req, res) => {
    const { quartoId } = req.query;

    if (!quartoId) {
        return res.status(400).json({ erro: 'Parâmetro quartoId é obrigatório.' });
    }

    try {
        const reservas = await pool.query(
            `SELECT data_checkin, data_checkout FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao')
             ORDER BY data_checkin ASC`,
            [quartoId]
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
    const client = await pool.connect();
    try {
        const { quartoId, hospedes, cliente, checkin, checkout } = req.body;

        if (!quartoId || !cliente || !checkin || !checkout) {
            return res.status(400).json({ erro: 'Dados incompletos para a reserva.' });
        }

        // Verifica disponibilidade do quarto
        const checkQuarto = await client.query('SELECT ativo FROM quartos WHERE id = $1', [quartoId]);
        if (checkQuarto.rows.length === 0 || !checkQuarto.rows[0].ativo) {
            return res.status(400).json({ erro: 'Quarto indisponível no momento.' });
        }

        // Bloqueia se já houver reserva paga OU bloqueio de balcão
        const conflito = await client.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Quarto já reservado ou indisponível nestas datas!' });
        }

        await client.query('BEGIN');

        // 1. Inserir ou obter o cliente
        const cpfLimpo = cliente.cpf ? cliente.cpf.replace(/\D/g, '') : '';
        let clienteRes = await client.query('SELECT id FROM clientes WHERE cpf = $1', [cpfLimpo]);
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

        // 2. Calcular valor total
        const d1 = new Date(`${checkin}T00:00:00`);
        const d2 = new Date(`${checkout}T00:00:00`);
        const dias = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
        
        if (dias <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Data de saída deve ser posterior à data de entrada.' });
        }

        const valorDiaria = calcularDiaria(quartoId, hospedes);
        const valorTotal = dias * valorDiaria;

        // 3. Criar pagamento via Mercado Pago Pix
        const paymentResponse = await payment.create({
            body: {
                transaction_amount: Number(valorTotal),
                description: `Reserva Quarto ${quartoId} - Hospedaria Central`,
                payment_method_id: 'pix',
                payer: {
                    email: cliente.email || 'contato@hospedariacentral.com.br',
                    first_name: cliente.nome,
                    identification: {
                        type: 'CPF',
                        number: cpfLimpo
                    }
                }
            }
        });

        // 4. Criar registro de reserva pendente no Banco
        const reservaRes = await client.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7) RETURNING id`,
            [quartoId, clienteId, hospedes || 1, checkin, checkout, valorTotal, String(paymentResponse.id)]
        );

        await client.query('COMMIT');

        // 5. Retornar dados do QR Code para o frontend
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
        res.status(500).json({ erro: 'Erro interno ao criar reserva. Verifique o servidor.' });
    } finally {
        client.release();
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
   ROTAS ADMINISTRATIVAS (PAINEL DO CELULAR / BALCÃO)
   ========================================================================== */

// ROTA ADMIN 1: Listar todas as ocupações ativas
app.get('/api/admin/reservas', async (req, res) => {
    try {
        const query = `
            SELECT r.id, r.quarto_id, q.numero_quarto, 
                   COALESCE(c.nome, 'Atendimento Presencial / Balcão') AS cliente_nome, 
                   COALESCE(c.telefone, 'Balcão') AS telefone,
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

    if (!quartoId || !checkin || !checkout) {
        return res.status(400).json({ erro: "Selecione o quarto e as datas para bloqueio." });
    }

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
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento) 
             VALUES ($1, NULL, 1, $2, $3, 0.00, 'bloqueado_balcao')`,
            [quartoId, checkin, checkout]
        );

        res.json({ mensagem: 'Data bloqueada com sucesso!' });
    } catch (err) {
        console.error("Erro ao bloquear data:", err);
        res.status(500).json({ erro: 'Erro interno ao salvar bloqueio no banco de dados.' });
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

// Inicialização do Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));