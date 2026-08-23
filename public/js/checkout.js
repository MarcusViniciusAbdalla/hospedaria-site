const mp = new MercadoPago('APP_USR-b5153fef-a39d-43f3-8364-353206364399');

const params = new URLSearchParams(window.location.search);
const quartoId = params.get('quartoId');
const start = params.get('start');
const end = params.get('end');
const adults = params.get('adults') || 1;

let reservaIdGlobal = null;
let valorTotalGlobal = 0;
let checandoPagamento = null;

document.getElementById('sum-checkin').innerText = start || '--/--/----';
document.getElementById('sum-checkout').innerText = end || '--/--/----';
document.getElementById('sum-adults').innerText = `${adults} pessoa(s)`;
document.getElementById('sum-room-name').innerText = `Quarto 0${quartoId || '1'} ${quartoId == 3 ? '(Suíte Master)' : ''}`;

document.getElementById('cust-tel').addEventListener('input', function (e) {
    let valor = e.target.value.replace(/\D/g, '');
    if (valor.length > 11) valor = valor.slice(0, 11);
    if (valor.length > 10) valor = valor.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
    else if (valor.length > 6) valor = valor.replace(/^(\d{2})(\d{4})(\d{0,4})$/, '($1) $2-$3');
    else if (valor.length > 2) valor = valor.replace(/^(\d{2})(\d{0,5})$/, '($1) $2');
    else if (valor.length > 0) valor = valor.replace(/^(\d*)/, '($1');
    e.target.value = valor;
});

async function carregarDetalhes() {
    if (!quartoId || !start || !end) return;
    try {
        const resp = await fetch(`/api/quartos-disponiveis?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&adults=${encodeURIComponent(adults)}`);
        const data = await resp.json();
        const quarto = (data.disponiveis || []).find(q => q.id == quartoId);

        if (quarto) {
            valorTotalGlobal = Number(quarto.valorTotal);
            document.getElementById('sum-total-price').innerText = `R$ ${valorTotalGlobal.toFixed(2)}`;
            document.getElementById('room-title').innerHTML = `<i class="fa-solid fa-bed"></i> Quarto 0${quarto.id} ${quarto.id == 3 ? '(Suíte Master)' : ''}`;
        }
    } catch (e) {
        console.error("Erro ao carregar detalhes:", e);
    }
}

document.getElementById('form-checkout-page').addEventListener('submit', async (e) => {
    e.preventDefault();
    const telLimpo = document.getElementById('cust-tel').value.replace(/\D/g, '');

    if (telLimpo.length < 10 || telLimpo.length > 11) {
        alert("O telefone deve conter DDD e o número completo.");
        return;
    }

    const lgpdCheckbox = document.getElementById('lgpd-aceite');

    if (!lgpdCheckbox.checked) {
        alert("⚠️ Por favor, marque a caixa concordando com os termos de privacidade para continuar com a reserva.");
        lgpdCheckbox.focus();
        return;
    }

    const payload = {
        quartoId: quartoId,
        hospedes: adults,
        checkin: start,
        checkout: end,
        cliente: {
            nome: document.getElementById('cust-nome').value.trim(),
            telefone: telLimpo,
            email: document.getElementById('cust-email').value.trim() || 'cliente@hospedariacentral.com.br'
        },
        aceiteLgpd: lgpdCheckbox.checked
    };

    try {
        const resp = await fetch('/api/reservar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resData = await resp.json();
        if (resp.ok && resData.sucesso) {
            reservaIdGlobal = resData.reservaId;

            document.getElementById('card-dados').style.display = 'none';
            document.getElementById('card-pagamento').style.display = 'block';

            document.getElementById('pix-qr-img').src = `data:image/jpeg;base64,${resData.qrCodeBase64}`;
            document.getElementById('pix-copia-cola').value = resData.pixCopiaECola;

            // Inicia a verificação automática se o Pix foi pago NA NOVA ROTA SEGURA
            iniciarVerificacaoPix();
        } else {
            alert(resData.erro || "Erro ao registrar reserva.");
        }
    } catch (err) {
        alert("Erro ao comunicar com o servidor.");
    }
});

function iniciarVerificacaoPix() {
    if (checandoPagamento) clearInterval(checandoPagamento);

    checandoPagamento = setInterval(async () => {
        if (!reservaIdGlobal) return;
        try {
            // O site agora pergunta na porta correta e segura!
            const resp = await fetch(`/api/reservas/${reservaIdGlobal}/status`);
            const data = await resp.json();

            if (data.status === 'pago') {
                clearInterval(checandoPagamento);
                
                // Transforma a tela de pagamento em comprovante de sucesso bonito
                document.getElementById('card-pagamento').innerHTML = `
                    <div style="text-align: center; padding: 20px;">
                        <i class="fa-solid fa-circle-check" style="font-size: 60px; color: #28a745; margin-bottom: 15px;"></i>
                        <h3 style="color: #28a745; border: none;">Pagamento Confirmado!</h3>
                        <p style="color: #555; margin-bottom: 20px;">Sua reserva na Hospedaria Central está <strong>100% garantida</strong>.</p>
                        <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; text-align: left; margin-bottom: 20px; border: 1px solid #e5e7eb; font-size: 14px;">
                            <p style="margin: 5px 0;">🛏️ <strong>Quarto:</strong> 0${quartoId}</p>
                            <p style="margin: 5px 0;">📅 <strong>Entrada:</strong> ${start} (a partir das 14h)</p>
                            <p style="margin: 5px 0;">📅 <strong>Saída:</strong> ${end} (até as 12h)</p>
                            <p style="margin: 5px 0;">📍 <strong>Local:</strong> Em frente ao Hospital Sylvio de Mello</p>
                            <p style="font-size: 13px; color: #666; margin-bottom: 20px;">🔐 <strong>Atenção:</strong> As instruções de acesso e a senha do Wi-Fi serão enviadas para o seu WhatsApp e E-mail <strong>1 dia antes da sua chegada</strong>!</p>
                        </div>
                        <p style="font-size: 13px; color: #666; margin-bottom: 20px;">Enviamos os dados completos, regras de convivência e contatos para o seu WhatsApp e E-mail!</p>
                        <a href="index.html" class="btn-pay-now" style="display: inline-block; text-decoration: none; text-align: center; background-color: #2e8b57; color: white; padding: 12px 24px; border-radius: 6px; font-weight: bold;">Voltar para a Página Inicial</a>
                    </div>
                `;
            }
        } catch (err) {
            console.error("Erro ao verificar status do Pix:", err);
        }
    }, 4000); // Checa a cada 4 segundos
}

function alternarMetodo(metodo) {
    if (metodo === 'cartao') {
        document.getElementById('metodo-cartao').style.display = 'block';
        document.getElementById('metodo-pix').style.display = 'none';
        document.querySelectorAll('.tab-btn')[0].classList.add('active');
        document.querySelectorAll('.tab-btn')[1].classList.remove('active');
    } else {
        document.getElementById('metodo-cartao').style.display = 'none';
        document.getElementById('metodo-pix').style.display = 'block';
        document.querySelectorAll('.tab-btn')[0].classList.remove('active');
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
    }
}

document.getElementById('form-pagamento-cartao').addEventListener('submit', async (e) => {
    e.preventDefault();

    const cardNumber = document.getElementById('form-card-number').value.replace(/\s+/g, '');
    const cardHolder = document.getElementById('form-card-holder').value.trim();
    const expiry = document.getElementById('form-card-expiry').value.split('/');
    const cvv = document.getElementById('form-card-cvv').value.trim();
    const email = document.getElementById('cust-email').value.trim();

    if (expiry.length !== 2) {
        alert("Validade inválida. Use o formato MM/AA.");
        return;
    }

    const cardExpirationMonth = expiry[0].trim();
    const cardExpirationYear = '20' + expiry[1].trim();

    try {
        const tokenObj = await mp.fields.createCardToken({
            cardNumber,
            cardholderName: cardHolder,
            cardExpirationMonth,
            cardExpirationYear,
            securityCode: cvv
        });

        const payloadCartao = {
            token: tokenObj.id,
            paymentMethodId: 'credit_card',
            installments: 1,
            amount: valorTotalGlobal,
            email: email,
            description: `Reserva Quarto ${quartoId} - Hospedaria Central`,
            reservaId: reservaIdGlobal
        };

        const resp = await fetch('/api/processar-cartao', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadCartao)
        });

        const data = await resp.json();

        if (resp.ok && data.sucesso) {
            document.getElementById('card-pagamento').style.display = 'none';
            document.getElementById('card-sucesso-cartao').style.display = 'block';
        } else {
            alert("Pagamento não aprovado: " + (data.erro || "Verifique os dados do cartão"));
        }

    } catch (err) {
        console.error("Erro no token do cartão:", err);
        alert("Erro ao validar o cartão. Verifique os dados digitados.");
    }
});

function copiarPix() {
    const copyText = document.getElementById("pix-copia-cola");
    copyText.select();
    document.execCommand("copy");
    alert("Código Pix copiado com sucesso!");
}

carregarDetalhes();
