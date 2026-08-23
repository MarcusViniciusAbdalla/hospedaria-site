// Testa a rota de login do painel administrativo (POST /api/admin/login).
// O banco de dados e mockado (jest.mock('pg')) — os testes nao tocam no
// Postgres real, entao rodam rapido e nao dependem de credenciais de producao.

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
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { app } = require('../server');

// new Pool() aqui devolve a MESMA instancia mockada que o server.js usa
// internamente (o jest.mock acima faz o construtor sempre retornar o mesmo objeto).
const pool = new Pool();

describe('POST /api/admin/login', () => {
    let senhaHash;

    beforeAll(async () => {
        senhaHash = await bcrypt.hash('senhaCorreta123', 10);
    });

    beforeEach(() => {
        pool.query.mockReset();
        pool.query.mockResolvedValue({ rows: [] });
    });

    test('usuario e senha corretos retornam sucesso e um token', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 1, usuario: 'marcus', senha_hash: senhaHash }]
        });

        const resp = await request(app)
            .post('/api/admin/login')
            .send({ usuario: 'marcus', senha: 'senhaCorreta123' });

        expect(resp.status).toBe(200);
        expect(resp.body.sucesso).toBe(true);
        expect(typeof resp.body.token).toBe('string');
        expect(resp.body.token.length).toBeGreaterThan(10);
    });

    test('senha errada retorna 401 com mensagem generica', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 1, usuario: 'marcus', senha_hash: senhaHash }]
        });

        const resp = await request(app)
            .post('/api/admin/login')
            .send({ usuario: 'marcus', senha: 'senhaErrada' });

        expect(resp.status).toBe(401);
        expect(resp.body.erro).toBe('Usuário ou senha incorretos');
        expect(resp.body.token).toBeUndefined();
    });

    test('usuario inexistente retorna 401 com a MESMA mensagem generica', async () => {
        // Importante: a mensagem tem que ser identica a de senha errada,
        // senao da pra descobrir por tentativa e erro quais usuarios existem.
        pool.query.mockResolvedValueOnce({ rows: [] });

        const resp = await request(app)
            .post('/api/admin/login')
            .send({ usuario: 'naoexiste', senha: 'qualquercoisa' });

        expect(resp.status).toBe(401);
        expect(resp.body.erro).toBe('Usuário ou senha incorretos');
    });

    test('erro no banco de dados retorna 500 em vez de derrubar o servidor', async () => {
        pool.query.mockRejectedValueOnce(new Error('conexao recusada'));

        const resp = await request(app)
            .post('/api/admin/login')
            .send({ usuario: 'marcus', senha: 'qualquercoisa' });

        expect(resp.status).toBe(500);
    });
});
