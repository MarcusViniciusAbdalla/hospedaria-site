// 1. O SEGURANÇA DA PORTA: Verifica se tem a pulseira antes de carregar a página
const pulseiraVIP = localStorage.getItem('tokenHospedaria');
if (!pulseiraVIP) {
    // Se não tem pulseira, expulsa para o login imediatamente
    window.location.href = '/login.html';
}
