// Testa o calculo de preco na camada HTTP: a rota administrativa que consulta
// o valor da diaria (/api/admin/calcular-diaria) e a rota publica de busca,
// que usa a mesma funcao pra montar o valor total de cada quarto disponivel.

process.env.JWT_SECRET = 'test_secret_for_jest';
// Evita que o setup inicial do server.js tente criar usuarios admin de verdade
// (ele rodaria bcrypt.hash de forma assincrona e vazaria pra depois do teste).
process.env.SENHA_MARCUS = '';
process.env.SENHA_KLESSIA = '';

jest.mock('pg', () => {
    const mPool = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn(), end: jest.fn() };
    return { Pool: jest.fn(() => mPool) };
});
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { app } = require('../server');

const pool = new Pool();
const tokenValido = jwt.sign({ id: 1, usuario: 'marcus' }, 'test_secret_for_jest', { expiresIn: '1h' });

beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
});

describe('GET /api/admin/calcular-diaria', () => {
    test('sem token de autenticacao, retorna 403', async () => {
        const resp = await request(app).get('/api/admin/calcular-diaria?quartoId=1&hospedes=2');
        expect(resp.status).toBe(403);
    });

    test('quarto comum com 2 hospedes retorna R$ 130,00', async () => {
        const resp = await request(app)
            .get('/api/admin/calcular-diaria?quartoId=1&hospedes=2')
            .set('Authorization', `Bearer ${tokenValido}`);

        expect(resp.status).toBe(200);
        expect(resp.body.valorDiaria).toBe(130.00);
    });

    test('Suite Master (quarto 3) com 3 hospedes retorna R$ 200,00', async () => {
        const resp = await request(app)
            .get('/api/admin/calcular-diaria?quartoId=3&hospedes=3')
            .set('Authorization', `Bearer ${tokenValido}`);

        expect(resp.status).toBe(200);
        expect(resp.body.valorDiaria).toBe(200.00);
    });
});

describe('GET /api/quartos-disponiveis', () => {
    test('calcula o valor total multiplicando a diaria pelos dias da estadia', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 1, numero_quarto: 1, capacidade_maxima: 3, ativo: true }]
        });

        const resp = await request(app)
            .get('/api/quartos-disponiveis?start=2026-09-10&end=2026-09-13&adults=2');

        expect(resp.status).toBe(200);
        expect(resp.body.disponiveis).toHaveLength(1);

        const quarto = resp.body.disponiveis[0];
        expect(quarto.diasReservados).toBe(3);
        expect(quarto.valorDiaria).toBe(130.00);
        expect(quarto.valorTotal).toBe(390.00); // 3 diarias x R$ 130,00
    });

    test('sem parametro de data obrigatorio, retorna 400', async () => {
        const resp = await request(app).get('/api/quartos-disponiveis?adults=2');
        expect(resp.status).toBe(400);
    });
});
