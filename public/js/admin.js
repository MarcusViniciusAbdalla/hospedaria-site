// --- FUNÇÃO DE SAIR (LOGOUT) ---
function sairDoPainel() {
    localStorage.removeItem('tokenHospedaria'); // Joga a pulseira no lixo
    window.location.href = '/login.html'; // Volta pra porta da rua
}

// ==========================================
// 🔔 AVISO E CONFIRMAÇÃO (substituem alert()/confirm() do navegador)
// ==========================================

// Mostra um aviso simples com botão OK. tipo muda o ícone: 'sucesso', 'erro', 'aviso' ou 'info' (padrão)
function mostrarAlerta(mensagem, tipo = 'info') {
    const icones = {
        sucesso: '<i class="fa-solid fa-circle-check" style="color: #28a745;"></i>',
        erro: '<i class="fa-solid fa-circle-xmark" style="color: #d9534f;"></i>',
        aviso: '<i class="fa-solid fa-triangle-exclamation" style="color: #e67e22;"></i>',
        info: '<i class="fa-solid fa-circle-info" style="color: #007bff;"></i>'
    };
    document.getElementById('alerta-icone').innerHTML = icones[tipo] || icones.info;
    document.getElementById('alerta-mensagem').textContent = mensagem;
    document.getElementById('modal-alerta').style.display = 'flex';
}

function fecharAlerta() {
    document.getElementById('modal-alerta').style.display = 'none';
}

// Substitui o confirm(). Use assim: if (await confirmarAcao("...")) { ... }
// perigo=true deixa o botão de confirmar vermelho (pra ações tipo cancelar/excluir)
function confirmarAcao(mensagem, perigo = false) {
    return new Promise((resolve) => {
        document.getElementById('confirmar-mensagem').textContent = mensagem;
        const btnSim = document.getElementById('btn-confirmar-sim');
        const btnNao = document.getElementById('btn-confirmar-nao');
        btnSim.className = perigo ? 'btn-status-cancel' : 'btn-status-confirm';
        document.getElementById('modal-confirmar').style.display = 'flex';

        function limpar() {
            document.getElementById('modal-confirmar').style.display = 'none';
            btnSim.removeEventListener('click', onSim);
            btnNao.removeEventListener('click', onNao);
        }
        function onSim() { limpar(); resolve(true); }
        function onNao() { limpar(); resolve(false); }

        btnSim.addEventListener('click', onSim);
        btnNao.addEventListener('click', onNao);
    });
}

let checkinBloqueio = '', checkoutBloqueio = '', dataObj1 = null, dataObj2 = null;
let manutencoesCache = []; // guarda a última lista de manutenções buscada, pra pintar os calendários sem refazer a busca 4x
let dashStart = '';
let dashEnd = '';

flatpickr("#dash-filtro-data", {
    mode: "range",
    locale: "pt",
    dateFormat: "Y-m-d",
    onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
            dashStart = selectedDates[0].toISOString().split('T')[0];
            dashEnd = selectedDates[1].toISOString().split('T')[0];
        } else {
            dashStart = '';
            dashEnd = '';
        }
    }
});

function aplicarFiltroDashboard() {
    if (!dashStart || !dashEnd) {
        mostrarAlerta("Por favor, selecione as duas datas no calendário para filtrar.", 'aviso');
        return;
    }
    carregarDashboard(dashStart, dashEnd);
}

function limparFiltroDashboard() {
    document.getElementById('dash-filtro-data').value = '';
    dashStart = '';
    dashEnd = '';
    carregarDashboard();
}

async function carregarDashboard(start = '', end = '') {
    try {
        let url = '/api/admin/dashboard';
        if (start && end) {
            url += `?start=${start}&end=${end}`;
        }
        const resp = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        if (resp.ok) {
            const data = await resp.json();
            document.getElementById('dash-mes').innerText = data.mesAtual;
            document.getElementById('dash-faturamento').innerText = `R$ ${data.faturamento.replace('.', ',')}`;
            document.getElementById('dash-ocupacao').innerText = `${data.ocupacao}%`;
        }
    } catch (err) {
        console.error("Erro ao carregar dashboard:", err);
    }
}

let faturamentoChartInstance = null;

async function carregarGraficoFaturamento() {
    try {
        const resp = await fetch('/api/admin/grafico-faturamento', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        if (resp.ok) {
            const data = await resp.json();

            const ctx = document.getElementById('faturamentoChart').getContext('2d');

            if (faturamentoChartInstance) {
                faturamentoChartInstance.destroy();
            }

            faturamentoChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data.labels,
                    datasets: [{
                        label: 'Faturamento (R$)',
                        data: data.dados,
                        backgroundColor: '#d97757',
                        borderRadius: 6,
                        barPercentage: 0.6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                callback: function (value) {
                                    return 'R$ ' + value;
                                }
                            }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    let label = context.dataset.label || '';
                                    if (label) { label += ': '; }
                                    if (context.parsed.y !== null) {
                                        label += 'R$ ' + context.parsed.y.toFixed(2).replace('.', ',');
                                    }
                                    return label;
                                }
                            }
                        }
                    }
                }
            });
        }
    } catch (err) {
        console.error("Erro ao carregar gráfico:", err);
    }
}

async function exportarFaturamentoCSV() {
    try {
        const resp = await fetch('/api/admin/exportar-faturamento', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        const data = await resp.json();

        if (!data.faturamento || data.faturamento.length === 0) {
            mostrarAlerta("Nenhum faturamento encontrado para exportar.", 'aviso');
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
        csvContent += "ID Reserva;Data Entrada;Data Saida;Quarto;Hospede;Status do Pagamento;Valor Faturado (R$)\n";

        data.faturamento.forEach(f => {
            const id = f.id;
            const entrada = f.data_entrada;
            const saida = f.data_saida;
            const quarto = f.numero_quarto;
            const hospede = `"${(f.cliente || '').replace(/"/g, '""')}"`;
            const status = f.status_pagamento;
            const valor = Number(f.valor_total || 0).toFixed(2).replace('.', ',');

            csvContent += `${id};${entrada};${saida};${quarto};${hospede};${status};${valor}\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `DRE_Faturamento_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

    } catch (e) {
        mostrarAlerta("Erro ao gerar a planilha de faturamento.", 'erro');
    }
}

// Pergunta pro servidor o valor da diária (mesma função que calcula reservas de verdade),
// em vez de ter uma segunda tabela de preços aqui no painel.
async function obterDiariaReferencia(quartoId, hospedes) {
    try {
        const resp = await fetch(`/api/admin/calcular-diaria?quartoId=${quartoId}&hospedes=${hospedes}`, {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        if (!resp.ok) return 75.00; // fallback caso a chamada falhe
        const data = await resp.json();
        return data.valorDiaria;
    } catch (e) {
        return 75.00; // fallback caso a conexão falhe
    }
}

async function calcularValorSugerido() {
    if (dataObj1 && dataObj2) {
        const diffTempo = dataObj2.getTime() - dataObj1.getTime();
        const dias = Math.ceil(diffTempo / (1000 * 3600 * 24)) || 1;
        const quartoId = document.getElementById('bloqueio-quarto').value;
        const hospedes = document.getElementById('bloqueio-hospedes').value;

        const valorDiaria = await obterDiariaReferencia(quartoId, hospedes);
        const valorTotalCalculado = (dias * valorDiaria).toFixed(2);

        document.getElementById('bloqueio-valor-sugerido').value = `R$ ${valorTotalCalculado} (${dias} diária/s)`;
        document.getElementById('bloqueio-valor').value = valorTotalCalculado;
    } else {
        document.getElementById('bloqueio-valor-sugerido').value = 'R$ 0,00';
    }
}

function formatarDataBR(dataIso) {
    if (!dataIso) return '--/--/----';
    const partes = dataIso.split('T')[0].split('-');
    if (partes.length !== 3) return dataIso;
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

// Evita que nomes/telefones com código malicioso (ex: <img onerror=...>) rodem no painel
function escapeHTML(texto) {
    if (texto === null || texto === undefined) return '';
    return String(texto)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

document.getElementById('bloqueio-quarto').addEventListener('change', calcularValorSugerido);
document.getElementById('bloqueio-hospedes').addEventListener('change', calcularValorSugerido);

flatpickr("#bloqueio-datas", {
    mode: "range",
    locale: "pt",
    minDate: "today",
    dateFormat: "Y-m-d",
    onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
            dataObj1 = selectedDates[0];
            dataObj2 = selectedDates[1];
            checkinBloqueio = selectedDates[0].toISOString().split('T')[0];
            checkoutBloqueio = selectedDates[1].toISOString().split('T')[0];
            calcularValorSugerido();
        } else {
            dataObj1 = null; dataObj2 = null;
            document.getElementById('bloqueio-valor-sugerido').value = 'R$ 0,00';
        }
    }
});

// Modificamos a chamada para ela rodar logo que a página abrir
async function carregarTudo() {
    carregarDashboard();
    carregarGraficoFaturamento();
    carregarAgenda();
    await carregarManutencoes(); // espera terminar, pra já ter os dados na hora de pintar os calendários
    [1, 2, 3, 4].forEach(quartoId => carregarCalendarioQuarto(quartoId));
}

// Ativa o carregamento inicial da página automaticamente
carregarTudo();

async function carregarCalendarioQuarto(quartoId) {
    const elem = document.getElementById(`cal-quarto-${quartoId}`);
    if (!elem) return;
    try {
        // Rota pública de disponibilidade, não exige token
        const resp = await fetch(`/api/disponibilidade?quartoId=${quartoId}`);
        let datasOcupadas = [];
        if (resp.ok) {
            const dados = await resp.json();
            datasOcupadas = (dados.diasOcupados || []).map(r => ({
                from: r.data_checkin.split('T')[0],
                to: r.data_checkout.split('T')[0]
            }));
        }

        // Filtra do cache só as manutenções deste quarto específico
        const datasManutencao = manutencoesCache
            .filter(m => String(m.quarto_id) === String(quartoId))
            .map(m => ({
                from: m.data_inicio.split('T')[0],
                to: m.data_fim.split('T')[0]
            }));

        elem.innerHTML = '';
        flatpickr(elem, {
            inline: true,
            locale: "pt",
            minDate: "today",
            defaultDate: "today",
            disable: [...datasOcupadas, ...datasManutencao],
            dateFormat: "Y-m-d",
            onDayCreate: function (dObj, dStr, fp, dayElem) {
                const dataFormatada = dayElem.dateObj.toISOString().split('T')[0];
                const eReserva = datasOcupadas.some(faixa => {
                    return dataFormatada >= faixa.from && dataFormatada < faixa.to;
                });
                const eManutencao = datasManutencao.some(faixa => {
                    return dataFormatada >= faixa.from && dataFormatada <= faixa.to;
                });
                if (eReserva) {
                    dayElem.classList.add("dia-ocupado");
                } else if (eManutencao) {
                    dayElem.classList.add("dia-manutencao");
                }
            }
        });
    } catch (e) { console.error(`Erro ao carregar calendário ${quartoId}:`, e); }
}

async function carregarAgenda() {
    const container = document.getElementById('lista-reservas');
    try {
        const response = await fetch('/api/admin/reservas', {
            headers: {
                'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria')
            }
        });

        if (response.status === 401 || response.status === 403) {
            localStorage.removeItem('tokenHospedaria');
            window.location.href = '/login.html';
            return;
        }
        const data = await response.json();
        container.innerHTML = '';
        window.cacheReservas = {}; // guarda nome/telefone por id, evita colocar texto livre dentro de atributos HTML
        if (!data.reservas || data.reservas.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #777; padding: 20px;">Nenhuma reserva ativa cadastrada no momento.</p>';
            return;
        }
        data.reservas.forEach(r => {
            let badge = '';
            let botoesAcao = '';

            if (r.status_pagamento === 'concluido') {
                badge = '<span style="background:#007bff; color:white; padding:3px 8px; border-radius:4px; font-size:11px;">Efetivada / Concluída</span>';
            } else if (r.status_pagamento === 'bloqueado_balcao') {
                badge = '<span style="background:#e0a800; color:white; padding:3px 8px; border-radius:4px; font-size:11px;">Balcão (Pendente Validação)</span>';
            } else if (r.status_pagamento === 'pago') {
                badge = '<span style="background:#28a745; color:white; padding:3px 8px; border-radius:4px; font-size:11px;">Pix Site Pago</span>';
            } else if (r.status_pagamento === 'checkin') {
                badge = '<span style="background:#17a2b8; color:white; padding:3px 8px; border-radius:4px; font-size:11px;"><i class="fa-solid fa-key"></i> Hóspede no Quarto</span>';
            }

            const numQuarto = String(r.numero_quarto).replace(/\D/g, '').padStart(2, '0');
            const valorFormatado = Number(r.valor_total || 0).toFixed(2);
            const nomeHospedeCru = r.cliente_nome || 'Hóspede Não Identificado';
            const telHospedeCru = r.telefone ? r.telefone : 'Sem Telefone';
            const nomeHospede = escapeHTML(nomeHospedeCru);
            const telHospede = escapeHTML(telHospedeCru);
            window.cacheReservas[r.id] = { nome: nomeHospedeCru, telefone: telHospedeCru };
            const qtdHospedes = r.quantidade_hospedes || 1;
            const checkinBR = formatarDataBR(r.data_checkin);
            const checkoutBR = formatarDataBR(r.data_checkout);

            if (r.status_pagamento !== 'checkin') {
                botoesAcao = `
                    <button class="btn-status-confirm" style="background: #17a2b8;" onclick="fazerCheckin(${r.id})">
                    <i class="fa-solid fa-door-open"></i> Check-in
                    </button>
                    <button class="btn-status-confirm" onclick="abrirModalEfetivar(${r.id})">
                    <i class="fa-solid fa-pen"></i> Editar
                    </button>
                    <button class="btn-status-confirm" style="background: #e67e22;" onclick="estenderReserva(${r.id})">
                    <i class="fa-solid fa-calendar-plus"></i> +1 Dia
                    </button>
                    <button class="btn-status-cancel" onclick="cancelarReserva(${r.id})">
                    <i class="fa-solid fa-xmark"></i> Cancelar
                    </button>
                    <button onclick="enviarLembrete(${r.id})" style="background-color: #3b82f6; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; margin-left: 5px;">
                    <i class="fa-solid fa-bell"></i> Lembrete
                    </button>  
                `;
            } else {
                botoesAcao = `
                    <button class="btn-status-cancel" style="background: #343a40;" onclick="fazerCheckout(${r.id})">
                    <i class="fa-solid fa-person-walking-arrow-right"></i> Registrar Check-out
                    </button>
                    <button class="btn-status-cancel" style="background: #dc3545; margin-left: 8px;" onclick="cancelarReserva(${r.id})">
                    <i class="fa-solid fa-trash"></i> Excluir
                    </button>
                `;
            }

            container.innerHTML += `
                <div class="reservation-item" style="display:flex; justify-content:space-between; align-items:center; padding:15px; border-bottom:1px solid #eee; flex-wrap:wrap; gap:10px; background:#fff; margin-bottom:10px; border-radius:8px; border:1px solid #e0e0e0;">
                    <div class="reservation-info">
                        <div style="font-size:16px; margin-bottom:4px;"><strong>Quarto ${numQuarto}</strong> &nbsp; ${badge}</div>
                        <div style="color:#555; font-size:13px; margin-bottom:2px;"><i class="fa-regular fa-calendar" style="color:var(--terracotta);"></i> <strong>Período:</strong> ${checkinBR} até ${checkoutBR}</div>
                        <div style="color:#222; font-size:14px; margin-bottom:2px;"><i class="fa-solid fa-user" style="color:var(--brown-dark);"></i> <strong>Hóspede:</strong> ${nomeHospede} (${qtdHospedes} pessoa/s)</div>
                        <div style="color:#25d366; font-size:13px; margin-bottom:4px;"><i class="fa-brands fa-whatsapp"></i> <strong>Contato:</strong> ${telHospede}</div>
                        <div><strong style="color:var(--brown-dark); font-size:15px;">Valor Total: R$ ${valorFormatado}</strong></div>
                    </div>
                    <div style="display:flex; gap:8px;">${botoesAcao}</div>
                </div>
            `;
        });
    } catch (err) {
        container.innerHTML = '<p style="color: red; text-align: center;">Erro ao carregar a lista de ocupações.</p>';
    }
}

async function exportarLeadsCSV() {
    try {
        const resp = await fetch('/api/admin/exportar-leads', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        const data = await resp.json();
        if (!data.leads || data.leads.length === 0) {
            mostrarAlerta("Nenhum lead encontrado para exportar.", 'aviso');
            return;
        }
        let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
        csvContent += "Nome;Telefone;Email;Total de Estadias;Total Gasto (R$)\n";
        data.leads.forEach(l => {
            const nome = `"${(l.nome || '').replace(/"/g, '""')}"`;
            const tel = `"${l.telefone || ''}"`;
            const email = `"${l.email || ''}"`;
            const estadias = l.total_estadias || 0;
            const valor = Number(l.total_gasto || 0).toFixed(2).replace('.', ',');
            csvContent += `${nome};${tel};${email};${estadias};${valor}\n`;
        });
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `leads_hospedaria_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (e) { mostrarAlerta("Erro ao gerar arquivo de leads.", 'erro'); }
}

document.getElementById('form-bloqueio').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!checkinBloqueio || !checkoutBloqueio) {
        mostrarAlerta("Selecione o período de entrada e saída.", 'aviso');
        return;
    }
    const valorCobrado = document.getElementById('bloqueio-valor').value;
    if (!valorCobrado || parseFloat(valorCobrado) <= 0) {
        mostrarAlerta("Informe o valor cobrado.", 'aviso');
        return;
    }
    document.getElementById('modal-lead-bloqueio').style.display = 'flex';
});

function fecharModalLead() { document.getElementById('modal-lead-bloqueio').style.display = 'none'; }

document.getElementById('form-lead-bloqueio').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nome = document.getElementById('lead-nome').value.trim();
    const telefone = document.getElementById('lead-telefone').value.replace(/\D/g, '');
    const email = document.getElementById('lead-email').value.trim();

    if (telefone.length < 10 || telefone.length > 11) {
        mostrarAlerta("O telefone deve conter DDD e o número completo.", 'aviso');
        return;
    }

    const payload = {
        quartoId: document.getElementById('bloqueio-quarto').value,
        hospedes: document.getElementById('bloqueio-hospedes').value,
        checkin: checkinBloqueio,
        checkout: checkoutBloqueio,
        valorTotal: document.getElementById('bloqueio-valor').value,
        cliente: { nome: nome, telefone: telefone, email: email }
    };

    try {
        const resp = await fetch('/api/admin/bloquear', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria')
            },
            body: JSON.stringify(payload)
        });
        const resData = await resp.json();
        if (resp.ok) {
            mostrarAlerta(resData.mensagem, 'sucesso');
            fecharModalLead();
            document.getElementById('form-lead-bloqueio').reset();
            document.getElementById('bloqueio-datas').value = '';
            document.getElementById('bloqueio-valor').value = '';
            document.getElementById('bloqueio-valor-sugerido').value = 'R$ 0,00';
            checkinBloqueio = ''; checkoutBloqueio = ''; dataObj1 = null; dataObj2 = null;
            carregarTudo();
        } else { mostrarAlerta(resData.erro || "Erro ao efetuar bloqueio.", 'erro'); }
    } catch (err) { mostrarAlerta("Erro ao comunicar com o servidor.", 'erro'); }
});

function abrirModalEfetivar(id) {
    const dados = (window.cacheReservas && window.cacheReservas[id]) || { nome: '', telefone: '' };
    const nomeAtual = dados.nome;
    const telAtual = dados.telefone;
    document.getElementById('efetivar-reserva-id').value = id;
    document.getElementById('efetivar-nome').value = (nomeAtual.includes('Balcão') || nomeAtual.includes('Hóspede Não')) ? '' : nomeAtual;
    document.getElementById('efetivar-telefone').value = (telAtual.includes('Balcão') || telAtual.includes('Sem')) ? '' : telAtual;
    document.getElementById('modal-efetivar').style.display = 'flex';
}

function fecharModalEfetivar() { document.getElementById('modal-efetivar').style.display = 'none'; }

document.getElementById('form-efetivar-dados').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('efetivar-reserva-id').value;
    const nome = document.getElementById('efetivar-nome').value;
    const telefone = document.getElementById('efetivar-telefone').value.replace(/\D/g, '');
    try {
        const resp = await fetch(`/api/admin/reservas/${id}/efetivar`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria')
            },
            body: JSON.stringify({ nome, telefone })
        });
        if (resp.ok) {
            fecharModalEfetivar();
            carregarTudo();
        } else { mostrarAlerta("Erro ao editar os dados da reserva.", 'erro'); }
    } catch (e) { mostrarAlerta("Erro ao conectar com o servidor.", 'erro'); }
});

async function cancelarReserva(id) {
    if (await confirmarAcao("Tem certeza que deseja CANCELAR esta reserva e liberar a data no calendário?", true)) {
        try {
            const resp = await fetch(`/api/admin/reservas/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
            });
            const data = await resp.json();
            if (resp.ok) {
                mostrarAlerta(data.mensagem, 'sucesso');
                carregarTudo();
            } else { mostrarAlerta(data.erro || "Erro ao cancelar.", 'erro'); }
        } catch (e) { mostrarAlerta("Erro de conexão ao cancelar.", 'erro'); }
    }
}

async function fazerCheckin(id) {
    if (await confirmarAcao("Confirmar a entrada do hóspede (Check-in)?")) {
        try {
            const resp = await fetch(`/api/admin/reservas/${id}/checkin`, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
            });
            if (resp.ok) carregarTudo();
            else mostrarAlerta("Erro ao registrar Check-in.", 'erro');
        } catch (e) { mostrarAlerta("Erro de conexão.", 'erro'); }
    }
}

async function fazerCheckout(id) {
    if (await confirmarAcao("Confirmar a saída do hóspede (Check-out)? A reserva sairá da lista principal.")) {
        try {
            const resp = await fetch(`/api/admin/reservas/${id}/checkout`, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
            });
            if (resp.ok) carregarTudo();
            else mostrarAlerta("Erro ao registrar Check-out.", 'erro');
        } catch (e) { mostrarAlerta("Erro de conexão.", 'erro'); }
    }
}

function aplicarMascaraTelefone(e) {
    let valor = e.target.value.replace(/\D/g, '');
    if (valor.length > 11) valor = valor.slice(0, 11);
    if (valor.length > 10) valor = valor.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
    else if (valor.length > 6) valor = valor.replace(/^(\d{2})(\d{4})(\d{0,4})$/, '($1) $2-$3');
    else if (valor.length > 2) valor = valor.replace(/^(\d{2})(\d{0,5})$/, '($1) $2');
    else if (valor.length > 0) valor = valor.replace(/^(\d*)/, '($1');
    e.target.value = valor;
}

document.getElementById('lead-telefone').addEventListener('input', aplicarMascaraTelefone);
document.getElementById('efetivar-telefone').addEventListener('input', aplicarMascaraTelefone);

async function estenderReserva(id) {
    if (await confirmarAcao('Deseja estender a diária deste quarto por mais 1 dia?')) {
        try {
            const res = await fetch(`/api/admin/reservas/${id}/estender`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
            });
            const data = await res.json();

            if (res.ok) {
                mostrarAlerta('Sucesso: ' + data.mensagem, 'sucesso');
                carregarTudo(); // Recarrega a tela instantaneamente
            } else {
                mostrarAlerta('Aviso: ' + data.erro, 'aviso');
            }
        } catch (err) {
            mostrarAlerta('Erro de conexão ao tentar estender a reserva.', 'erro');
        }
    }
}

async function enviarLembrete(idReserva) {
    if (!(await confirmarAcao("Deseja disparar o e-mail e abrir o WhatsApp de lembrete para este hóspede?"))) return;

    // A aba abre logo aqui, ainda "colada" no clique do botão Confirmar do modal,
    // antes do fetch (que demora) — assim o navegador não bloqueia o popup
    const whatsappTab = window.open('about:blank', '_blank');

    try {
        const response = await fetch(`/api/admin/reservas/${idReserva}/lembrete`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        const data = await response.json();

        if (data.sucesso) {
            // Se o sistema devolveu o telefone, joga o link do zap naquela aba em branco
            if (data.telefoneCliente && data.textoWhatsapp) {
                const url = `https://wa.me/${data.telefoneCliente}?text=${encodeURIComponent(data.textoWhatsapp)}`;
                whatsappTab.location.href = url;
            } else {
                whatsappTab.close(); // Fecha a aba se não tiver telefone
                mostrarAlerta("O cliente não possui um telefone válido no cadastro.", 'aviso');
            }
        } else {
            whatsappTab.close();
            mostrarAlerta("Erro: " + (data.erro || "Não foi possível processar."), 'erro');
        }
    } catch (error) {
        whatsappTab.close();
        console.error("Erro:", error);
        mostrarAlerta("Erro de conexão ao tentar processar o lembrete.", 'erro');
    }
}

let manutDataInicio = '', manutDataFim = '';

// Guardamos a instância (não só o seletor) pra poder preencher as datas na hora de editar
const manutencaoPicker = flatpickr("#manutencao-datas", {
    mode: "range",
    locale: "pt",
    dateFormat: "Y-m-d",
    onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
            manutDataInicio = selectedDates[0].toISOString().split('T')[0];
            manutDataFim = selectedDates[1].toISOString().split('T')[0];
        } else {
            manutDataInicio = ''; manutDataFim = '';
        }
    }
});

// Sem argumento: abre em branco pra criar uma manutenção nova.
// Com um id: busca os dados no cache e abre já preenchido pra editar.
function abrirModalManutencao(id = null) {
    document.getElementById('form-manutencao').reset();
    document.getElementById('manutencao-id').value = '';
    manutencaoPicker.clear();
    manutDataInicio = ''; manutDataFim = '';

    const titulo = document.getElementById('modal-manutencao-titulo');
    const botao = document.getElementById('btn-manutencao-submit');

    if (id !== null) {
        const item = manutencoesCache.find(m => String(m.id) === String(id));
        if (!item) {
            mostrarAlerta('Não foi possível carregar os dados desta manutenção. Tente recarregar a página.', 'erro');
            return;
        }
        document.getElementById('manutencao-id').value = item.id;
        document.getElementById('manutencao-quarto').value = item.quarto_id;
        document.getElementById('manutencao-motivo').value = item.motivo || '';
        const inicio = item.data_inicio.split('T')[0];
        const fim = item.data_fim.split('T')[0];
        manutencaoPicker.setDate([inicio, fim], true); // true = já dispara onChange e preenche manutDataInicio/Fim
        titulo.innerHTML = '<i class="fas fa-tools" style="color: #e67e22;"></i> Editar Período de Manutenção';
        botao.textContent = 'Salvar Alterações';
    } else {
        titulo.innerHTML = '<i class="fas fa-tools" style="color: #e67e22;"></i> Colocar Quarto em Manutenção';
        botao.textContent = 'Salvar Manutenção';
    }

    document.getElementById('modal-manutencao').style.display = 'flex';
}

function fecharModalManutencao() {
    document.getElementById('modal-manutencao').style.display = 'none';
}

document.getElementById('form-manutencao').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!manutDataInicio || !manutDataFim) {
        mostrarAlerta('Selecione o período de manutenção no calendário.', 'aviso');
        return;
    }
    const idEdicao = document.getElementById('manutencao-id').value;
    const quartoId = document.getElementById('manutencao-quarto').value;
    const motivo = document.getElementById('manutencao-motivo').value.trim();

    // Se tem ID, é edição de uma manutenção que já existe (PUT). Sem ID, é uma nova (POST).
    const url = idEdicao ? `/api/admin/quarto/manutencao/${idEdicao}` : '/api/admin/quarto/manutencao';
    const method = idEdicao ? 'PUT' : 'POST';

    try {
        const resp = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria')
            },
            body: JSON.stringify({ quartoId, dataInicio: manutDataInicio, dataFim: manutDataFim, motivo })
        });
        const data = await resp.json();
        if (resp.ok) {
            fecharModalManutencao();
            await carregarManutencoes();
            [1, 2, 3, 4].forEach(quartoId => carregarCalendarioQuarto(quartoId));
        } else {
            mostrarAlerta('Erro: ' + (data.erro || 'Não foi possível salvar a manutenção.'), 'erro');
        }
    } catch (err) {
        mostrarAlerta('Erro de conexão ao salvar a manutenção.', 'erro');
    }
});

async function carregarManutencoes() {
    const container = document.getElementById('lista-manutencoes');
    try {
        const resp = await fetch('/api/admin/manutencoes', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
        });
        if (!resp.ok) throw new Error('Falha ao buscar');
        const data = await resp.json();
        manutencoesCache = data.manutencoes || []; // guarda pra pintar os calendários de amarelo
        container.innerHTML = '';
        if (manutencoesCache.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #777; padding: 20px;">Nenhum quarto em manutenção no momento.</p>';
            return;
        }
        manutencoesCache.forEach(m => {
            const numQuarto = String(m.numero_quarto).padStart(2, '0');
            const inicioBR = formatarDataBR(m.data_inicio);
            const fimBR = formatarDataBR(m.data_fim);
            const motivo = escapeHTML(m.motivo || 'Sem motivo informado');
            container.innerHTML += `
                <div class="reservation-item" style="display:flex; justify-content:space-between; align-items:center; padding:15px; border-bottom:1px solid #eee; flex-wrap:wrap; gap:10px; background:#fff; margin-bottom:10px; border-radius:8px; border:1px solid #e0e0e0;">
                    <div class="reservation-info">
                        <div style="font-size:16px; margin-bottom:4px;"><strong>Quarto ${numQuarto}</strong></div>
                        <div style="color:#555; font-size:13px; margin-bottom:2px;"><i class="fa-regular fa-calendar" style="color:#e67e22;"></i> <strong>Período:</strong> ${inicioBR} até ${fimBR}</div>
                        <div style="color:#666; font-size:13px;"><i class="fas fa-comment-dots"></i> <strong>Motivo:</strong> ${motivo}</div>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="btn-status-confirm" onclick="abrirModalManutencao(${m.id})">
                        <i class="fa-solid fa-pen"></i> Editar
                        </button>
                        <button class="btn-status-cancel" onclick="removerManutencao(${m.id})">
                        <i class="fa-solid fa-xmark"></i> Retirar
                        </button>
                    </div>
                </div>
            `;
        });
    } catch (err) {
        container.innerHTML = '<p style="color: red; text-align: center;">Erro ao carregar manutenções.</p>';
    }
}

async function removerManutencao(id) {
    if (await confirmarAcao('Remover este período de manutenção? O quarto volta a ficar disponível para essas datas.', true)) {
        try {
            const resp = await fetch(`/api/admin/quarto/manutencao/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('tokenHospedaria') }
            });
            const data = await resp.json();
            if (resp.ok) {
                await carregarManutencoes();
                [1, 2, 3, 4].forEach(quartoId => carregarCalendarioQuarto(quartoId));
            } else {
                mostrarAlerta('Erro: ' + (data.erro || 'Não foi possível remover.'), 'erro');
            }
        } catch (err) {
            mostrarAlerta('Erro de conexão ao remover a manutenção.', 'erro');
        }
    }
}


