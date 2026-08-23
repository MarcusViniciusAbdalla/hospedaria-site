// Testa a funcao pura que calcula o valor da diaria — sem banco de dados,
// sem servidor HTTP, so a logica de precificacao mesmo.

process.env.JWT_SECRET = 'test_secret_for_jest';
// Evita que o setup inicial do server.js tente criar usuarios admin de verdade
// (ele rodaria bcrypt.hash de forma assincrona e vazaria pra depois do teste).
process.env.SENHA_MARCUS = '';
process.env.SENHA_KLESSIA = '';

// server.js cria o Pool e agenda cron jobs assim que e carregado (require),
// entao mesmo um teste que so precisa de uma funcao pura precisa mockar isso.
jest.mock('pg', () => {
    const mPool = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn(), end: jest.fn() };
    return { Pool: jest.fn(() => mPool) };
});
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const { calcularDiaria } = require('../server');

describe('calcularDiaria', () => {
    test('quarto comum (1, 2 ou 4) com 1 hospede cobra R$ 75,00', () => {
        expect(calcularDiaria(1, 1)).toBe(75.00);
        expect(calcularDiaria(2, 1)).toBe(75.00);
        expect(calcularDiaria(4, 1)).toBe(75.00);
    });

    test('quarto comum com 2 hospedes cobra R$ 130,00', () => {
        expect(calcularDiaria(1, 2)).toBe(130.00);
    });

    test('quarto comum com 3 hospedes cobra R$ 180,00', () => {
        expect(calcularDiaria(1, 3)).toBe(180.00);
    });

    test('quarto 03 (Suite Master) tem tabela de preco propria', () => {
        expect(calcularDiaria(3, 1)).toBe(100.00);
        expect(calcularDiaria(3, 2)).toBe(150.00);
        expect(calcularDiaria(3, 3)).toBe(200.00);
    });

    test('aceita quartoId e hospedes vindos como string (query params da URL)', () => {
        expect(calcularDiaria('3', '2')).toBe(150.00);
    });

    test('quantidade de hospedes invalida ou ausente cai no valor de 1 pessoa', () => {
        expect(calcularDiaria(1, 0)).toBe(75.00);
        expect(calcularDiaria(1, undefined)).toBe(75.00);
    });

    test('quarto comum com mais de 3 hospedes cai no valor padrao de R$ 75,00', () => {
        expect(calcularDiaria(1, 4)).toBe(75.00);
    });

    test('comportamento atual: Suite Master com mais de 3 hospedes tambem cai no padrao de R$ 75,00', () => {
        // Documenta o comportamento de hoje (nao ha um valor especifico pra
        // grupos grandes na Suite Master) — se isso mudar de proposito, o teste
        // avisa que a tabela de precos foi alterada.
        expect(calcularDiaria(3, 4)).toBe(75.00);
    });
});
