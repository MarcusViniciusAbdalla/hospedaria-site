require('dotenv').config();
const express = require('express');
const app = express();
app.set('trust proxy', 1);
const helmet = require('helmet');
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://sdk.mercadopago.com"],
            scriptSrcAttr: ["'unsafe-inline'"], // 🔑 A CHAVE MÁGICA: Libera o clique (onclick) dos seus botões!
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
            imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
            connectSrc: [
                "'self'", 
                "https://sdk.mercadopago.com", 
                "https://api.mercadopago.com", 
                "https://*.mercadopago.com", 
                "https://*.mercadolibre.com", 
                "https://cdn.jsdelivr.net"
            ],
            frameSrc: ["https://www.google.com"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            formAction: ["'self'"],
        },
    },
}));

app.use(express.json());
const https = require('https');
const { Pool } = require('pg');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');




// ==========================================
// 🛡️ SISTEMA DE SEGURANÇA (BACKLOG FASE 1)
// ==========================================

// 1. Filtro de Sanitização (XSS Clean)
// Limpa qualquer tentativa de injetar códigos maliciosos (vírus) nos campos de texto
function sanitizarTexto(texto) {
    if (typeof texto !== 'string') return texto;
    return texto
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .trim()
        .slice(0, 200); // nomes não precisam de mais que 200 caracteres
}

// 2. A Roleta da Porta (Rate Limiting)
// Lembra do IP do usuário por 15 minutos
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // Limite de 100 requisições por IP a cada 15 minutos
    message: { erro: "Detectamos tráfego incomum. A roleta de segurança travou. Por favor, aguarde 15 minutos." }
});

// Aplica a roleta de segurança em TODAS as portas de entrada da nossa API
app.use('/api/', limiter);

// ==========================================
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: { rejectUnauthorized: false }
});

// ATUALIZA A PRANCHETA DO BANCO DE DADOS E CRIA OS USUÁRIOS ADMIN
pool.query(`
    ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_status_pagamento_check;
    ALTER TABLE reservas ADD CONSTRAINT reservas_status_pagamento_check 
    CHECK (status_pagamento IN ('pendente', 'pago', 'cancelado', 'bloqueado_balcao', 'concluido', 'checkin', 'checkout'));

    ALTER TABLE quartos ADD COLUMN IF NOT EXISTS em_manutencao BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS manutencoes_quarto (
        id SERIAL PRIMARY KEY,
        quarto_id INTEGER NOT NULL REFERENCES quartos(id),
        data_inicio DATE NOT NULL,
        data_fim DATE NOT NULL,
        motivo TEXT,
        criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS administradores (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(50) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL
    );
`).then(async () => {
    console.log("Prancheta do banco de dados atualizada!");

    // 1. Cria o seu usuário (Marcus)
    const checkMarcus = await pool.query('SELECT * FROM administradores WHERE usuario = $1', ['marcus']);
    if (checkMarcus.rows.length === 0 && process.env.SENHA_MARCUS) {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(process.env.SENHA_MARCUS, salt);
        await pool.query('INSERT INTO administradores (usuario, senha_hash) VALUES ($1, $2)', ['marcus', hash]);
        console.log("Usuário 'marcus' criado com sucesso na fechadura digital.");
    }

    // 2. Cria o usuário da sua esposa (Klessia)
    const checkKlessia = await pool.query('SELECT * FROM administradores WHERE usuario = $1', ['klessia']);
    if (checkKlessia.rows.length === 0 && process.env.SENHA_KLESSIA) {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(process.env.SENHA_KLESSIA, salt);
        await pool.query('INSERT INTO administradores (usuario, senha_hash) VALUES ($1, $2)', ['klessia', hash]);
        console.log("Usuário 'klessia' criado com sucesso na fechadura digital.");
    }
}).catch(err => {
    console.log("Aviso ao atualizar banco (pode ignorar):", err.message);
});

const mpClient = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});
const payment = new Payment(mpClient);

// FUNÇÃO DE ENVIO VIA API DO BREVO (HTTPS - PORTA 443 100% LIVRE)
async function enviarEmailBrevo(destinatarioEmail, destinatarioNome, assunto, htmlConteudo) {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
        console.error("ERRO: Chave BREVO_API_KEY não configurada nas variáveis de ambiente!");
        return;
    }

    const dadosEnvio = JSON.stringify({
        sender: {
            name: "Hospedaria Central Morrinhos",
            email: process.env.EMAIL_USER
        },
        to: [{ email: destinatarioEmail, name: destinatarioNome }],
        subject: assunto,
        htmlContent: htmlConteudo
    });

    const options = {
        hostname: 'api.brevo.com',
        port: 443,
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': apiKey,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(dadosEnvio)
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[BREVO] E-mail enviado com sucesso para: ${destinatarioEmail}`);
                    resolve(true);
                } else {
                    console.error(`[BREVO] Erro ao enviar e-mail (${res.statusCode}):`, body);
                    reject(new Error(body));
                }
            });
        });

        req.on('error', (error) => {
            console.error('[BREVO] Erro na requisição HTTPS:', error);
            reject(error);
        });

        req.write(dadosEnvio);
        req.end();
    });
}

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

//function calcularDiaria(quartoId, hospedes) {
//  return 1.00; // 🛑 VALOR FIXO TEMPORÁRIO PARA O TESTE DE R$ 1,00
//}

// ROTA: PROCESSAR PAGAMENTO COM CARTÃO
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

// ROTAS PÚBLICAS
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
            AND NOT EXISTS (
                SELECT 1 FROM manutencoes_quarto m
                WHERE m.quarto_id = q.id
                AND (m.data_inicio, m.data_fim) OVERLAPS ($2::date, $3::date)
            )
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
// NOVA ROTA: O SITE PERGUNTA SE O PIX FOI PAGO
app.get('/api/reservas/:id/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT status_pagamento FROM reservas WHERE id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            res.json({ status: result.rows[0].status_pagamento });
        } else {
            res.status(404).json({ erro: 'Reserva não encontrada' });
        }
    } catch (err) {
        res.status(500).json({ erro: 'Erro interno' });
    }
});

app.post('/api/reservar', async (req, res) => {
    const client = await pool.connect();
    try {
        const { quartoId, hospedes, cliente, checkin, checkout, aceiteLgpd } = req.body;

        if (!aceiteLgpd) {
            return res.status(400).json({ erro: 'Você precisa aceitar os termos da LGPD para finalizar a reserva.' });
        }

        if (!quartoId || !cliente || !checkin || !checkout) {
            return res.status(400).json({ erro: 'Dados incompletos para a reserva.' });
        }

        // Limpa o nome antes de usá-lo em qualquer lugar (banco, e-mail, WhatsApp, painel admin)
        if (cliente.nome) cliente.nome = sanitizarTexto(cliente.nome);

        const conflito = await client.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
             AND data_checkin < $3::date 
             AND data_checkout > $2::date`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Quarto já reservado ou indisponível nestas datas!' });
        }

        await client.query('BEGIN');

        const cpfLimpo = cliente.cpf ? cliente.cpf.replace(/\D/g, '') : '';
        const cpfFinal = cpfLimpo.length > 0 ? cpfLimpo.substring(0, 14) : `C-${Date.now().toString().slice(-11)}`;

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

        const d1 = new Date(`${checkin}T00:00:00`);
        const d2 = new Date(`${checkout}T00:00:00`);
        const dias = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));

        if (dias <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Data de saída deve ser posterior à data de entrada.' });
        }

        const valorDiaria = calcularDiaria(quartoId, hospedes);
        const valorTotal = dias * valorDiaria;

        // A MÁGICA AQUI: O notification_url fala para o Mercado Pago onde nos avisar!
        const paymentResponse = await payment.create({
            body: {
                transaction_amount: Number(valorTotal),
                description: `Reserva Quarto ${quartoId} - Hospedaria Central`,
                payment_method_id: 'pix',
                notification_url: 'https://hospedaria-site.onrender.com/api/webhook/mercadopago',
                payer: {
                    email: cliente.email || 'cliente@hospedariacentral.com.br',
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

        // 1. AVISO POR E-MAIL PARA O ADMINISTRADOR (VOCÊ)
        try {
            const adminEmail = process.env.EMAIL_USER;
            const assuntoAdmin = `🔔 Nova Reserva: Quarto 0${quartoId} - ${cliente.nome}`;
            const htmlAdmin = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 500px; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h2 style="color: #d97757; margin-top: 0;">Nova Reserva Recebida! 🎉</h2>
                <p>Uma nova solicitação de reserva acabou de ser feita no site.</p>
                <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px;">
                    <p style="margin: 5px 0;">👤 <strong>Hóspede:</strong> ${cliente.nome}</p>
                    <p style="margin: 5px 0;">📞 <strong>Contato:</strong> ${cliente.telefone || 'Não informado'}</p>
                    <p style="margin: 5px 0;">🛏️ <strong>Quarto:</strong> 0${quartoId}</p>
                    <p style="margin: 5px 0;">📅 <strong>Período:</strong> ${checkin} a ${checkout}</p>
                    <p style="margin: 5px 0;">💰 <strong>Valor:</strong> R$ ${valorTotal.toFixed(2)}</p>
                </div>
                <p style="font-size: 12px; color: #777;">O status atual é "pendente". Acesse o painel para acompanhar quando o hóspede realizar o pagamento.</p>
            </div>
            `;

            enviarEmailBrevo(adminEmail, 'Administrador', assuntoAdmin, htmlAdmin)
                .catch(err => console.error("Falha ao enviar e-mail admin:", err));
        } catch (emailErr) {
            console.error("Erro interno ao preparar e-mail admin:", emailErr);
        }

        // 2. AVISO NO WHATSAPP PARA O SEU CELULAR
        try {
            const numeroWpp = process.env.CALLMEBOT_PHONE;
            const apiKeyWpp = process.env.CALLMEBOT_APIKEY;
            const textoMsg = `🔔 *Nova Reserva!*\nQuarto: 0${quartoId}\nCliente: ${cliente.nome}\nData: ${checkin} a ${checkout}\nValor: R$ ${valorTotal.toFixed(2)}`;

            const urlWpp = `https://api.callmebot.com/whatsapp.php?phone=${numeroWpp}&text=${encodeURIComponent(textoMsg)}&apikey=${apiKeyWpp}`;

            https.get(urlWpp, (resWpp) => {
                resWpp.on('data', () => { });
            }).on('error', (errWpp) => {
                console.error("Erro secundário no WhatsApp:", errWpp.message);
            });
        } catch (wppErr) {
            console.error("Falha ao tentar enviar WhatsApp:", wppErr);
        }

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

// WEBHOOK MERCADO PAGO
app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        // O Mercado Pago às vezes manda o ID em lugares diferentes da carta
        const pagamentoId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;

        if (pagamentoId) {
            const pagamentoInfo = await payment.get({ id: pagamentoId });

            if (pagamentoInfo.status === 'approved') {
                const result = await pool.query(`
                    UPDATE reservas 
                    SET status_pagamento = 'pago' 
                    WHERE mp_payment_id = $1 AND status_pagamento != 'pago'
                    RETURNING id, quarto_id, cliente_id, data_checkin, valor_total
                `, [String(pagamentoId)]);

                if (result.rows.length > 0) {
                    const reserva = result.rows[0];
                    // Busca nome, email e TELEFONE para o WhatsApp!
                    const clienteRes = await pool.query('SELECT nome, email, telefone FROM clientes WHERE id = $1', [reserva.cliente_id]);

                    if (clienteRes.rows.length > 0) {
                        const cliente = clienteRes.rows[0];
                        const checkinBR = new Date(reserva.data_checkin).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
                        const numQ = String(reserva.quarto_id).padStart(2, '0');

                        // 1. ENVIA E-MAIL PARA O CLIENTE
                        if (cliente.email && cliente.email.includes('@') && !cliente.email.includes('balcao')) {
                            const htmlConfirmacao = `
                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
                                <div style="background-color: #2e8b57; padding: 20px; text-align: center;">
                                    <h2 style="color: #fff; margin: 0;">Pagamento Confirmado! ✅</h2>
                                </div>
                                <div style="padding: 20px;">
                                    <p>Olá, <strong>${cliente.nome}</strong>!</p>
                                    <p>O seu pagamento via PIX no valor de R$ ${Number(reserva.valor_total).toFixed(2)} foi aprovado. A sua reserva está <strong>100% garantida</strong>!</p>
                                    <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #2e8b57; margin: 20px 0;">
                                        <p style="margin: 0;">🛏️ <strong>Quarto:</strong> 0${numQ}<br>
                                        📅 <strong>Data de Entrada:</strong> ${checkinBR} a partir das 14h</p>
                                        📍 <strong>Endereço:</strong> Centro de Morrinhos (em frente ao Hospital Sylvio de Mello)
                                    </div>
                                    <p>📞 <strong>Contatos:</strong> (64) 98459-4781 / (64) 99236-2298</p>
                                    <p>Falta pouco para você relaxar! <strong>Um dia antes da sua chegada</strong>, enviaremos outro e-mail com as instruções de acesso e a senha do Wi-Fi.</p>
                                </div>
                            </div>`;

                            await enviarEmailBrevo(cliente.email, cliente.nome, 'Reserva Confirmada com Sucesso! 🎉', htmlConfirmacao);
                        }

                        // 2. ENVIA WHATSAPP DE CONFIRMAÇÃO PARA O CLIENTE
                        if (cliente.telefone) {
                            const telLimpo = cliente.telefone.replace(/\D/g, '');
                            if (telLimpo.length >= 10) {
                                const telefoneFormatado = telLimpo.startsWith('55') ? telLimpo : `55${telLimpo}`;
                                const textoConfirmacaoWpp = `✅ *Pagamento Confirmado!*\n\nOlá, *${cliente.nome}*! O seu pagamento foi processado com sucesso. A sua reserva na *Hospedaria Central* está 100% garantida!\n\n🛏️ Quarto: 0${numQ}\n📅 Entrada: ${checkinBR} (a partir das 14h)\n📍 Endereço: Em frente ao Hospital Sylvio de Mello, Morrinhos-GO.\n\n🔐 *Atenção:* As instruções de acesso e a senha do Wi-Fi serão enviadas para você 1 dia antes do seu check-in!\n\n📞 Dúvidas? Fale conosco por aqui!`;

                                const urlWppCliente = `https://api.callmebot.com/whatsapp.php?phone=${telefoneFormatado}&text=${encodeURIComponent(textoConfirmacaoWpp)}&apikey=${process.env.CALLMEBOT_APIKEY}`;
                                https.get(urlWppCliente, (resWpp) => { resWpp.on('data', () => { }); }).on('error', () => { });
                            }
                        }
                    }
                }
            }
        }
        res.sendStatus(200); // Fala pro Mercado Pago: "Câmbio, desligo! Recebi a mensagem."
    } catch (err) {
        console.error("Erro no Webhook:", err);
        res.sendStatus(500);
    }
});


// ROTAS ADMINISTRATIVAS
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error("❌ ERRO FATAL: a variável de ambiente JWT_SECRET não foi definida. Configure-a no seu .env antes de iniciar o servidor.");
    process.exit(1);
}

// Lista todos os períodos de manutenção ainda válidos (que não terminaram no passado)
app.get('/api/admin/manutencoes', verificarPulseiraVIP, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.id, m.quarto_id, q.numero_quarto, m.data_inicio, m.data_fim, m.motivo
            FROM manutencoes_quarto m
            JOIN quartos q ON q.id = m.quarto_id
            WHERE m.data_fim >= CURRENT_DATE
            ORDER BY m.data_inicio ASC
        `);
        res.json({ manutencoes: result.rows });
    } catch (error) {
        console.error('Erro ao listar manutenções:', error);
        res.status(500).json({ erro: 'Erro ao buscar períodos de manutenção.' });
    }
});

// Cadastra um novo período de manutenção para um quarto
app.post('/api/admin/quarto/manutencao', verificarPulseiraVIP, async (req, res) => {
    const { quartoId, dataInicio, dataFim, motivo } = req.body;

    if (!quartoId || !dataInicio || !dataFim) {
        return res.status(400).json({ erro: 'Selecione o quarto e o período de manutenção.' });
    }

    try {
        await pool.query(
            `INSERT INTO manutencoes_quarto (quarto_id, data_inicio, data_fim, motivo)
             VALUES ($1, $2::date, $3::date, $4)`,
            [quartoId, dataInicio, dataFim, sanitizarTexto(motivo || '')]
        );
        res.json({ sucesso: true, mensagem: 'Período de manutenção cadastrado com sucesso!' });
    } catch (error) {
        console.error('Erro ao cadastrar manutenção:', error);
        res.status(500).json({ erro: 'Erro interno ao cadastrar manutenção.' });
    }
});

// Remove um período de manutenção (o quarto volta a ficar disponível nessas datas)
app.delete('/api/admin/quarto/manutencao/:id', verificarPulseiraVIP, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM manutencoes_quarto WHERE id = $1', [id]);
        res.json({ sucesso: true, mensagem: 'Período de manutenção removido.' });
    } catch (error) {
        console.error('Erro ao remover manutenção:', error);
        res.status(500).json({ erro: 'Erro interno ao remover manutenção.' });
    }
});


app.post('/api/admin/login', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const result = await pool.query('SELECT * FROM administradores WHERE usuario = $1', [usuario]);
        if (result.rows.length === 0) {
            return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
        }

        const admin = result.rows[0];
        const senhaValida = await bcrypt.compare(senha, admin.senha_hash);

        if (!senhaValida) {
            return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
        }

        const token = jwt.sign({ id: admin.id, usuario: admin.usuario }, JWT_SECRET, { expiresIn: '8h' });

        res.json({ sucesso: true, token, mensagem: 'Bem-vindo de volta!' });
    } catch (err) {
        console.error("Erro no login:", err);
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});

function verificarPulseiraVIP(req, res, next) {
    const tokenHeader = req.headers['authorization'];
    if (!tokenHeader) return res.status(403).json({ erro: 'Acesso negado. Área restrita.' });

    const token = tokenHeader.split(" ")[1];

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ erro: 'Sessão expirada ou pulseira inválida. Faça login novamente.' });
        req.adminId = decoded.id;
        next();
    });
}

app.get('/api/admin/reservas', verificarPulseiraVIP, async (req, res) => {
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

app.get('/api/admin/exportar-leads', verificarPulseiraVIP, async (req, res) => {
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

app.get('/api/admin/exportar-faturamento', verificarPulseiraVIP, async (req, res) => {
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

app.post('/api/admin/bloquear', verificarPulseiraVIP, async (req, res) => {
    const { quartoId, hospedes, checkin, checkout, valorTotal } = req.body;

    if (!quartoId || !checkin || !checkout) {
        return res.status(400).json({ erro: "Selecione o quarto e as datas para bloqueio." });
    }

    try {
        const conflito = await pool.query(
            `SELECT id FROM reservas 
             WHERE quarto_id = $1 
             AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
             AND data_checkin < $3::date 
             AND data_checkout > $2::date`,
            [quartoId, checkin, checkout]
        );

        if (conflito.rows.length > 0) {
            return res.status(400).json({ erro: 'Já existe reserva ou bloqueio para esta data!' });
        }

        const clienteObj = req.body.cliente || {};
        const nomeFinal = sanitizarTexto(clienteObj.nome || req.body.nome || 'Atendimento Presencial / Balcão');
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

app.put('/api/admin/reservas/:id/efetivar', verificarPulseiraVIP, async (req, res) => {
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

app.delete('/api/admin/reservas/:id', verificarPulseiraVIP, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE reservas SET status_pagamento = 'cancelado' WHERE id = $1", [id]);
        res.json({ mensagem: 'Reserva cancelada e data liberada com sucesso.' });
    } catch (err) {
        console.error("Erro ao cancelar reserva:", err);
        res.status(500).json({ erro: 'Erro ao remover reserva.' });
    }
});

app.post('/api/admin/reservas/:id/lembrete', verificarPulseiraVIP, async (req, res) => {
    const { id } = req.params;

    try {
        const query = `
            SELECT r.id, r.quarto_id, r.data_checkin, c.nome AS cliente_nome, c.email, c.telefone 
            FROM reservas r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.id = $1
        `;
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'Reserva não encontrada.' });
        }

        const reserva = result.rows[0];
        const checkinBR = new Date(reserva.data_checkin).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
        const numQ = String(reserva.quarto_id).padStart(2, '0');

        let emailEnviado = false;

        if (reserva.email && reserva.email.includes('@') && !reserva.email.includes('balcao')) {
            await enviarEmailBrevo(
                reserva.email,
                reserva.cliente_nome,
                'Lembrete: A sua reserva na Hospedaria Central é amanhã! 🧳',
                htmlEmailLembrete(reserva.cliente_nome, numQ, checkinBR)
            );
            emailEnviado = true;
        }

        let telefoneFormatado = '';
        let textoMsg = '';

        if (reserva.telefone) {
            const telLimpo = reserva.telefone.replace(/\D/g, '');
            if (telLimpo.length >= 10) {
                telefoneFormatado = telLimpo.startsWith('55') ? telLimpo : `55${telLimpo}`;
                textoMsg = `Olá, *${reserva.cliente_nome}*! 🏨 Passando para lembrar da sua reserva na *Hospedaria Central Morrinhos* para o dia *${checkinBR}* (Quarto 0${reserva.quarto_id}). Estamos te esperando! Dúvidas? (64) 98459-4781.`;
            }
        }

        res.json({
            sucesso: true,
            mensagem: `E-mail via Brevo processado! ${emailEnviado ? '(Enviado)' : '(Sem e-mail válido)'}`,
            telefoneCliente: telefoneFormatado,
            textoWhatsapp: textoMsg
        });

    } catch (err) {
        console.error("Erro ao disparar lembrete manual:", err);
        res.status(500).json({ erro: 'Erro interno ao enviar lembrete.' });
    }
});

app.put('/api/admin/reservas/:id/checkin', verificarPulseiraVIP, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(`
            UPDATE reservas 
            SET status_pagamento = 'checkin' 
            WHERE id = $1 
            RETURNING quarto_id, data_checkout, cliente_id
        `, [id]);

        if (result.rows.length === 0) throw new Error('Reserva não encontrada.');
        const reserva = result.rows[0];

        const clienteRes = await client.query('SELECT nome, email FROM clientes WHERE id = $1', [reserva.cliente_id]);
        let nomeHospede = clienteRes.rows.length > 0 ? clienteRes.rows[0].nome : 'Hóspede';
        let emailHospede = clienteRes.rows.length > 0 ? clienteRes.rows[0].email : '';

        const ehEmailValido = emailHospede && emailHospede.includes('@');

        if (ehEmailValido) {
            const checkoutBR = new Date(reserva.data_checkout).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
            const numQ = String(reserva.quarto_id).padStart(2, '0');

            enviarEmailBrevo(
                emailHospede,
                nomeHospede,
                'Bem-vindo(a) à Hospedaria Central Morrinhos! 🏨',
                htmlEmailCheckin(nomeHospede, numQ, checkoutBR)
            ).catch(err => console.error('Falha no envio do e-mail Check-in:', err));
        }

        await client.query('COMMIT');
        res.json({ sucesso: true, mensagem: 'Check-in realizado!' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro no checkin:", error);
        res.status(500).json({ erro: 'Erro ao registrar check-in.' });
    } finally {
        client.release();
    }
});

app.put('/api/admin/reservas/:id/checkout', verificarPulseiraVIP, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE reservas SET status_pagamento = 'checkout' WHERE id = $1", [id]);
        res.json({ mensagem: 'Check-out realizado! Reserva arquivada e quarto desocupado.' });
    } catch (err) {
        console.error("Erro ao fazer check-out:", err);
        res.status(500).json({ erro: 'Erro ao registrar check-out.' });
    }
});

app.get('/api/admin/dashboard', verificarPulseiraVIP, async (req, res) => {
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

app.get('/api/admin/grafico-faturamento', verificarPulseiraVIP, async (req, res) => {
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
    } catch (err) { }
}, 5 * 60 * 1000);

app.post('/api/admin/reservas/:id/estender', verificarPulseiraVIP, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const reservaAtual = await client.query('SELECT quarto_id, data_checkout, quantidade_hospedes FROM reservas WHERE id = $1', [id]);
        if (reservaAtual.rows.length === 0) {
            throw new Error('Reserva não encontrada.');
        }

        const { quarto_id, data_checkout, quantidade_hospedes } = reservaAtual.rows[0];

        const novaDataRes = await client.query(`SELECT $1::date + INTERVAL '1 day' AS nova_data`, [data_checkout]);
        const novaDataCheckout = novaDataRes.rows[0].nova_data;

        const conflito = await client.query(`
            SELECT id FROM reservas 
            WHERE quarto_id = $1 
            AND id != $2
            AND status_pagamento IN ('pago', 'bloqueado_balcao', 'concluido', 'checkin')
            AND (data_checkin, data_checkout) OVERLAPS ($3::date, $4::date)
        `, [quarto_id, id, data_checkout, novaDataCheckout]);

        if (conflito.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ erro: 'Quarto indisponível! Já existe uma reserva para amanhã.' });
        }

        const valorDiariaExtra = calcularDiaria(quarto_id, quantidade_hospedes);

        await client.query(`
            UPDATE reservas 
            SET data_checkout = $1::date,
                valor_total = valor_total + $2
            WHERE id = $3
        `, [novaDataCheckout, valorDiariaExtra, id]);

        await client.query('COMMIT');
        return res.json({ sucesso: true, mensagem: 'Diária estendida com sucesso!' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao estender:', error);
        return res.status(500).json({ erro: 'Erro interno ao estender a reserva.' });
    } finally {
        client.release();
    }
});

function htmlEmailCheckin(nome, quarto, checkout) {
    return `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #5c4033; padding: 20px; text-align: center;">
            <h2 style="color: #fff; margin: 0;">Bem-vindo(a) à Hospedaria Central Morrinhos! 🏨</h2>
        </div>
        <div style="padding: 20px;">
            <p>Olá, <strong>${nome}</strong>!</p>
            <p>É um prazer receber você. Seu check-in foi realizado com sucesso no nosso sistema.</p>
            
            <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #d97757; margin: 20px 0;">
                <p style="margin: 0; font-size: 16px;">🛏️ Quarto: <strong>${quarto}</strong><br>
                📅 Data de Saída: <strong>${checkout}</strong></p>
            </div>
            
            <p><strong>Informações Úteis:</strong><br>
            📶 <strong>Wi-Fi:</strong> Hospedagem | Senha: <em>84594781</em><br>
            ☕ Aproveite também para conhecer a nossa cafeteria, a <strong>Cafeteria Central</strong>, anexa à nossa estrutura! Estamos localizados em frente ao Hospital Sylvio de Mello para sua maior conveniência.</p>
            
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            
            <h3 style="color: #d97757; text-align: center;">🏠 REGRAS DA HOSPEDARIA CENTRAL MORRINHOS</h3>
            <p style="text-align: center; font-size: 13px; color: #666;"><em>Seja bem-vindo! Bom senso é a base da boa convivência.</em></p>
            
            <ul style="font-size: 13px; line-height: 1.6; padding-left: 20px;">
                <li>📞 <strong>Emergências e Contato:</strong> (64) 9 8459-4781 ou (64) 9 9236-2298. (Não há recepcionista 24h).</li>
                <li>🕒 <strong>Check-in / Check-out:</strong> Check-in a partir das 14h | Check-out até as 12h. Apresente documento na chegada.</li>
                <li>🚪 <strong>Ao Sair do Dormitório:</strong> Avise a saída com antecedência, deixe a chave no local indicado e confira portas e janelas.</li>
                <li>🔇 <strong>Horário de Silêncio (22h às 8h):</strong> Nada de som alto, conversas em corredores ou bagunça.</li>
                <li>🚿 <strong>Banheiros Compartilhados:</strong> Mantenha seco e limpo. Use chinelos dentro do box.</li>
                <li>🔒 <strong>Segurança:</strong> O hostel não se responsabiliza por objetos não guardados. Tranque a porta ao sair.</li>
                <li>🚫 <strong>Não é Permitido:</strong> Entrada de visitas sem autorização, fumar nos quartos, drogas ilícitas e perturbar o sossego.</li>
                <li>🤝 <strong>Respeito Sempre:</strong> Trate todos com educação. O desrespeito às regras pode levar à saída do hóspede sem reembolso.</li>
            </ul>
            <p style="text-align: center; font-weight: bold; margin-top: 20px;">Obrigado e aproveite sua estadia! 🌟</p>
        </div>
    </div>`;
}

function htmlEmailLembrete(nome, quarto, checkin) {
    return `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #d97757; padding: 20px; text-align: center;">
            <h2 style="color: #fff; margin: 0;">A sua reserva é amanhã! 🧳</h2>
        </div>
        <div style="padding: 20px;">
            <p>Olá, <strong>${nome}</strong>!</p>
            <p>Estamos passando para lembrar que a sua estadia conosco começa amanhã, dia <strong>${checkin}</strong>. O seu <strong>Quarto ${quarto}</strong> já está sendo preparado para te receber com muito conforto!</p>
            
            <p>📍 <strong>Nosso Endereço:</strong> Centro de Morrinhos (em frente ao Hospital e Maternidade Sylvio de Mello).</p>
            <p>Para que você já chegue por dentro de como funcionamos, adiantamos abaixo as nossas diretrizes de convivência:</p>
            
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <h3 style="color: #5c4033; text-align: center;">🏠 REGRAS DA HOSPEDARIA CENTRAL MORRINHOS</h3>
            <ul style="font-size: 13px; line-height: 1.6; padding-left: 20px;">
                <li>📞 <strong>Emergências/Contato:</strong> (64) 9 8459-4781 ou (64) 9 9236-2298. (Sem recepção 24h).</li>
                <li>🕒 <strong>Check-in/Out:</strong> Entrada a partir das 14h | Saída até as 12h. Traga documento.</li>
                <li>🚪 <strong>Saídas:</strong> Avise antecedência, deixe a chave no local indicado.</li>
                <li>🔇 <strong>Silêncio (22h-8h):</strong> Sem som alto, conversas altas em corredores ou bagunça.</li>
                <li>🚿 <strong>Banheiros:</strong> Mantenha seco e limpo após usar.</li>
                <li>🔒 <strong>Segurança:</strong> Tranque a porta. Não nos responsabilizamos por pertences soltos.</li>
                <li>🚫 <strong>Proibido:</strong> Visitas sem autorização, fumo interno, drogas, e perturbar o sossego.</li>
                <li>🤝 <strong>Respeito:</strong> O desrespeito pode causar cancelamento sem reembolso.</li>
            </ul>
            <p>Se precisar alterar o seu horário de chegada, é só responder a este e-mail. Desejamos uma excelente viagem!</p>
        </div>
    </div>`;
}

cron.schedule('0 8 * * *', async () => {
    try {
        const amanha = new Date();
        amanha.setDate(amanha.getDate() + 1);
        const dataIso = amanha.toISOString().split('T')[0];

        const result = await pool.query(`
            SELECT r.id, c.nome AS cliente_nome, c.email, r.quarto_id, r.data_checkin 
            FROM reservas r
            JOIN clientes c ON c.id = r.cliente_id
            WHERE r.data_checkin = $1 
            AND r.status_pagamento = 'pago' 
            AND c.email IS NOT NULL 
            AND c.email LIKE '%@%'
            AND c.email NOT IN ('balcao@hospedariacentral.com.br', 'cliente@hospedariacentral.com.br')
        `, [dataIso]);

        for (let r of result.rows) {
            const checkinBR = new Date(r.data_checkin).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
            const numQ = String(r.quarto_id).padStart(2, '0');

            await enviarEmailBrevo(
                r.email,
                r.cliente_nome,
                'A sua reserva na Hospedaria Central Morrinhos é amanhã! 🧳',
                htmlEmailLembrete(r.cliente_nome, numQ, checkinBR)
            );
        }
    } catch (err) {
        console.error('Erro no robô de lembretes:', err);
    }
});

// ==========================================
// 🤖 ROBÔ DE AUTO CHECK-OUT (Todos os dias às 13:00)
// ==========================================
cron.schedule('0 13 * * *', async () => {
    try {
        // Pega a data de hoje certinha
        const dataHojeIso = new Date().toISOString().split('T')[0];

        // Manda o banco de dados liberar os quartos cuja data de saída é hoje (ou antes de hoje)
        const limpeza = await pool.query(`
            UPDATE reservas 
            SET status_pagamento = 'checkout' 
            WHERE status_pagamento IN ('checkin', 'pago', 'concluido', 'bloqueado_balcao') 
            AND data_checkout <= $1
        `, [dataHojeIso]);

        if (limpeza.rowCount > 0) {
            console.log(`[AUTO CHECK-OUT] ${limpeza.rowCount} quarto(s) liberado(s) automaticamente às 13h!`);
        }
    } catch (err) {
        console.error('Erro no robô de auto check-out:', err);
    }
}, {
    scheduled: true,
    timezone: "America/Sao_Paulo" // Garante que será às 13h no horário de Brasília/Goiás!
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
