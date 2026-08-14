require('dotenv').config();
const express = require('express');
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

// ==========================================================================
// ROTA: PROCESSAR PAGAMENTO COM CARTÃO (CRÉDITO / DÉBITO)
// ==========================================================================
app.post('/api/processar-cartao', async (req, res) => {
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

        res.json({ 
            sucesso: true, 
            status: paymentResponse.status,
            paymentId: paymentResponse.id 
        });
    } catch (error) {
        console.error('ERRO AO PROCESSAR CARTÃO:', error);
        res.status(400).json({ erro: error.message || 'Erro ao processar pagamento com cartão.' });
    }
});

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
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
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
                WHERE status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
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
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Quarto já reservado ou indisponível nestas datas!' });
        }

        await client.query('BEGIN');

        const cpfLimpo = cliente.cpf ? cliente.cpf.replace(/\D/g, '') : '';
        let clienteRes = await client.query('SELECT id FROM clientes WHERE telefone = $1', [cliente.telefone]);
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
                    first_name: cliente.nome
                }
            }
        });

        const reservaRes = await client.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, $3, $4::date, $5::date, $6, 'pendente', $7) RETURNING id`,
            [quartoId, clienteId, hospedes || 1, checkin, checkout, valorTotal, String(paymentResponse.id)]
        );

        await client.query('COMMIT');
        // AVISO NO WHATSAPP (CallMeBot)
        const mensagem = encodeURIComponent(`🔔 *Nova reserva na Hospedaria Central!*\nQuarto: ${quartoId}\nCliente: ${cliente.nome}\nData: ${checkin} a ${checkout}\nValor: R$ ${valorTotal}`);
        const urlAviso = `https://api.callmebot.com/whatsapp.php?phone=556484594781&text=${mensagem}&apikey=5774787`;

       fetch(urlAviso).catch(err => console.error("Erro no alerta WhatsApp:", err));

        
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

// WEBHOOK ATUALIZADO (SUPORTA PIX E CARTÃO COM SEGURANÇA MÁXIMA)
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
            SELECT r.id, r.quarto_id, q.numero_quarto, r.quantidade_hospedes,
                   COALESCE(c.nome, 'Atendimento Presencial / Balcão') AS cliente_nome, 
                   COALESCE(c.telefone, 'Sem Telefone') AS telefone,
                   r.data_checkin, r.data_checkout, r.status_pagamento, r.valor_total
            FROM reservas r
            JOIN quartos q ON q.id = r.quarto_id
            LEFT JOIN clientes c ON c.id = r.cliente_id
            WHERE r.status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
            ORDER BY r.data_checkin ASC;
        `;
        const result = await pool.query(query);
        res.json({ reservas: result.rows });
    } catch (err) {
        console.error("Erro ao buscar reservas admin:", err);
        res.status(500).json({ erro: 'Erro ao carregar reservas.' });
    }
});

app.get('/api/admin/exportar-leads', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.nome, 
                c.telefone, 
                c.email, 
                COUNT(r.id) AS total_estadias,
                SUM(CASE WHEN r.status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin', 'checkout') THEN r.valor_total ELSE 0 END) AS total_gasto
            FROM clientes c
            LEFT JOIN reservas r ON r.cliente_id = c.id
            WHERE c.cpf NOT LIKE 'BALCAO-%' AND c.nome NOT LIKE '%Atendimento Presencial%'
            GROUP BY c.id, c.nome, c.telefone, c.email
            ORDER BY total_estadias DESC;
        `;
        const result = await pool.query(query);
        res.json({ leads: result.rows });
    } catch (err) {
        console.error("Erro ao exportar leads:", err);
        res.status(500).json({ erro: "Erro ao buscar lista de leads." });
    }
});

app.get('/api/admin/exportar-faturamento', async (req, res) => {
    try {
        const query = `
            SELECT 
                r.id,
                TO_CHAR(r.data_checkin, 'DD/MM/YYYY') as data_entrada,
                TO_CHAR(r.data_checkout, 'DD/MM/YYYY') as data_saida,
                q.numero_quarto,
                COALESCE(c.nome, 'Balcão / Presencial') as cliente,
                r.valor_total,
                r.status_pagamento
            FROM reservas r
            JOIN quartos q ON q.id = r.quarto_id
            LEFT JOIN clientes c ON c.id = r.cliente_id
            WHERE r.status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin', 'checkout')
            ORDER BY r.data_checkin DESC;
        `;
        const result = await pool.query(query);
        res.json({ faturamento: result.rows });
    } catch (err) {
        console.error("Erro ao exportar faturamento:", err);
        res.status(500).json({ erro: "Erro ao buscar dados de faturamento." });
    }
});

app.post('/api/admin/bloquear', async (req, res) => {
    const { quartoId, hospedes, checkin, checkout, valorTotal } = req.body;

    if (!quartoId || !checkin || !checkout) {
        return res.status(400).json({ erro: "Selecione o quarto e as datas para bloqueio." });
    }

    try {
        const conflito = await pool.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
             AND (data_checkin, data_checkout) OVERLAPS ($2::date, $3::date)`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Já existe reserva ou bloqueio para esta data!' });
        }

        const clienteObj = req.body.cliente || {};
        const nomeFinal = clienteObj.nome || req.body.nome || 'Atendimento Presencial / Balcão';
        const telefoneFinal = clienteObj.telefone || req.body.telefone || '(64) 00000-0000';
        const emailFinal = clienteObj.email || req.body.email || 'balcao@hospedariacentral.com.br';

        let clienteId;
        const clienteExistente = await pool.query(
            `SELECT id FROM clientes WHERE telefone = $1 AND telefone != '(64) 00000-0000'`,
            [telefoneFinal]
        );

        if (clienteExistente.rows.length > 0) {
            clienteId = clienteExistente.rows[0].id;
        } else {
            const cpfCurtoBalcao = `B-${Date.now().toString().slice(-11)}`;
            const novoCliente = await pool.query(
                `INSERT INTO clientes (nome, cpf, telefone, email) 
                 VALUES ($1, $2, $3, $4) 
                 RETURNING id`,
                [nomeFinal, cpfCurtoBalcao, telefoneFinal, emailFinal]
            );
            clienteId = novoCliente.rows[0].id;
        }

        const valorSalvar = parseFloat(valorTotal) || 0.00;
        const numHospedes = parseInt(hospedes) || 1;

        await pool.query(
            `INSERT INTO reservas (quarto_id, cliente_id, quantidade_hospedes, data_checkin, data_checkout, valor_total, status_pagamento, mp_payment_id) 
             VALUES ($1, $2, $3, $4::date, $5::date, $6, 'bloqueado_balcao', 'balcao_presencial')`,
            [quartoId, clienteId, numHospedes, checkin, checkout, valorSalvar]
        );

        res.json({ mensagem: 'Bloqueio e reserva salvos com sucesso!' });

    } catch (err) {
        console.error("ERRO DETALHADO DO BANCO (admin/bloquear):", err);
        res.status(500).json({ erro: 'Erro interno ao salvar no banco.', detalhe: err.message });
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

app.put('/api/admin/reservas/:id/checkin', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE reservas SET status_pagamento = 'checkin' WHERE id = $1", [id]);
        res.json({ mensagem: 'Check-in realizado! Hóspede na pousada.' });
    } catch (err) {
        console.error("Erro ao fazer check-in:", err);
        res.status(500).json({ erro: 'Erro ao registrar check-in.' });
    }
});

app.put('/api/admin/reservas/:id/checkout', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE reservas SET status_pagamento = 'checkout' WHERE id = $1", [id]);
        res.json({ mensagem: 'Check-out realizado! Reserva arquivada e quarto desocupado.' });
    } catch (err) {
        console.error("Erro ao fazer check-out:", err);
        res.status(500).json({ erro: 'Erro ao registrar check-out.' });
    }
});

app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const { start, end } = req.query;
        let firstDay, lastDay, textoPeriodo;

        if (start && end) {
            firstDay = start;
            lastDay = end;
            const ds = start.split('-');
            const de = end.split('-');
            textoPeriodo = `${ds[2]}/${ds[1]} até ${de[2]}/${de[1]}`;
        } else {
            const currentDate = new Date();
            firstDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).toISOString().split('T')[0];
            lastDay = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).toISOString().split('T')[0];
            
            textoPeriodo = currentDate.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
            textoPeriodo = textoPeriodo.charAt(0).toUpperCase() + textoPeriodo.slice(1);
        }

        const faturamentoQuery = `
            SELECT SUM(valor_total) as total_faturado
            FROM reservas
            WHERE status_pagamento IN ('pago', 'concluido', 'checkin', 'checkout')
            AND data_checkin >= $1 AND data_checkin <= $2
        `;
        const faturamentoResult = await pool.query(faturamentoQuery, [firstDay, lastDay]);
        const totalFaturado = faturamentoResult.rows[0].total_faturado || 0;

        const ocupacaoQuery = `
            SELECT SUM(data_checkout - data_checkin) as dias_ocupados
            FROM reservas
            WHERE status_pagamento IN ('pago', 'concluido', 'checkin', 'checkout')
            AND data_checkin >= $1 AND data_checkin <= $2
        `;
        const ocupacaoResult = await pool.query(ocupacaoQuery, [firstDay, lastDay]);
        const diasOcupados = ocupacaoResult.rows[0].dias_ocupados || 0;
        
        const d1 = new Date(`${firstDay}T00:00:00`);
        const d2 = new Date(`${lastDay}T00:00:00`);
        const diasNaPesquisa = Math.max(1, Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);
        
        const totalDiariasPossiveis = diasNaPesquisa * 4;
        const taxaOcupacao = ((diasOcupados / totalDiariasPossiveis) * 100).toFixed(1);

        res.json({
            faturamento: Number(totalFaturado).toFixed(2),
            ocupacao: taxaOcupacao > 100 ? 100 : taxaOcupacao,
            mesAtual: textoPeriodo
        });
    } catch (err) {
        console.error("Erro ao gerar dashboard:", err);
        res.status(500).json({ erro: 'Erro ao gerar dados do dashboard.' });
    }
});

app.get('/api/admin/grafico-faturamento', async (req, res) => {
    try {
        const query = `
            SELECT 
                TO_CHAR(data_checkin, 'YYYY-MM') as mes_ano,
                SUM(valor_total) as total_faturado
            FROM reservas
            WHERE status_pagamento IN ('pago', 'concluido', 'checkin', 'checkout')
              AND data_checkin >= NOW() - INTERVAL '12 months'
            GROUP BY TO_CHAR(data_checkin, 'YYYY-MM')
            ORDER BY mes_ano ASC;
        `;
        const result = await pool.query(query);

        const mesesLabels = [];
        const faturamentos = [];
        const nomesMeses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

        result.rows.forEach(row => {
            const ano = row.mes_ano.split('-')[0];
            const mesIdx = parseInt(row.mes_ano.split('-')[1], 10) - 1;
            mesesLabels.push(`${nomesMeses[mesIdx]}/${ano.slice(2)}`);
            faturamentos.push(Number(row.total_faturado).toFixed(2));
        });

        res.json({
            labels: mesesLabels,
            dados: faturamentos
        });
    } catch (err) {
        console.error("Erro ao gerar dados do gráfico:", err);
        res.status(500).json({ erro: 'Erro ao buscar dados do gráfico.' });
    }
});

/* ==========================================================================
   ROTINA DE LIMPEZA AUTOMÁTICA
   ========================================================================== */
setInterval(async () => {
    try {
        const limpeza = await pool.query(`
            UPDATE reservas 
            SET status_pagamento = 'cancelado' 
            WHERE status_pagamento = 'pendente' 
            AND created_at < NOW() - INTERVAL '30 minutes'
        `);
        
        if (limpeza.rowCount > 0) {
            console.log(`[LIMPEZA AUTOMÁTICA] Cancelou ${limpeza.rowCount} reserva(s) não paga(s).`);
        }
    } catch (err) {}
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));