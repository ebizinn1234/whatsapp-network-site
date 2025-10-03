import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from '../config/database.js';

const router = express.Router();
const JWT_SECRET = 'whatsapp123456789012345678901234567890';

// Registro de usuário
router.post('/register', async (req, res) => {
    try {
        const { phone, password, recoveryQuestion, recoveryAnswer } = req.body;

        // Validar telefone brasileiro (10 ou 11 dígitos)
        const cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length < 10 || cleanPhone.length > 11) {
            return res.json({ success: false, error: 'Telefone deve ter 10 ou 11 dígitos (apenas números brasileiros)' });
        }

        // Verificar se o usuário já existe
        const [existingUser] = await db.execute(
            'SELECT id FROM users WHERE phone = ?',
            [cleanPhone]
        );

        if (existingUser.length > 0) {
            return res.json({ success: false, error: 'Usuário já existe' });
        }

        // Hash da senha
        const passwordHash = await bcrypt.hash(password, 10);
        const recoveryAnswerHash = await bcrypt.hash(recoveryAnswer, 10);

        // Criar usuário
        const [result] = await db.execute(
            'INSERT INTO users (phone, password_hash, recovery_question, recovery_answer) VALUES (?, ?, ?, ?)',
            [cleanPhone, passwordHash, recoveryQuestion, recoveryAnswerHash]
        );

        const userId = result.insertId;

        // Gerar token JWT
        const token = jwt.sign({ userId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            success: true,
            token,
            user: { id: userId, phone: cleanPhone }
        });

    } catch (error) {
        console.error('Erro no registro:', error);
        res.json({ success: false, error: 'Erro interno do servidor' });
    }
});

// Login de usuário
router.post('/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        // Validar telefone brasileiro (10 ou 11 dígitos)
        const cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length < 10 || cleanPhone.length > 11) {
            return res.json({ success: false, error: 'Telefone deve ter 10 ou 11 dígitos (apenas números brasileiros)' });
        }

        // Buscar usuário
        const [users] = await db.execute(
            'SELECT id, phone, password_hash FROM users WHERE phone = ?',
            [cleanPhone]
        );

        if (users.length === 0) {
            return res.json({ success: false, error: 'Usuário não encontrado' });
        }

        const user = users[0];

        // Verificar senha
        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return res.json({ success: false, error: 'Senha incorreta' });
        }

        // Gerar token JWT
        const token = jwt.sign({ userId: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            success: true,
            token,
            user: { id: user.id, phone: user.phone }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.json({ success: false, error: 'Erro interno do servidor' });
    }
});

// Middleware para verificar token
export const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ success: false, error: 'Token não fornecido' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, error: 'Token inválido' });
    }
};

export default router;
