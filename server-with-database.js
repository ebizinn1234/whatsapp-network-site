import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configuração do banco de dados
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_network',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'whatsapp-network-secret-key';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Armazenar sessões ativas por usuário
const userSessions = new Map();

// Função para conectar ao WhatsApp
async function connectToWhatsApp(userId, socket) {
    try {
        console.log(`🔄 Conectando WhatsApp para usuário ${userId}...`);
        
        // Buscar dados do usuário no banco
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            socket.emit('error', 'Usuário não encontrado');
            return;
        }
        
        const user = users[0];
        const authDir = `./auth_info_user_${userId}`;
        
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            browser: ['DisparoZap', 'Chrome', '1.0.0']
        });

        // Salvar sessão no banco
        await pool.execute(
            'INSERT INTO whatsapp_sessions (user_id, is_active) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_active = ?, updated_at = CURRENT_TIMESTAMP',
            [userId, true, true]
        );

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log(`📱 QR Code gerado para usuário ${userId}!`);
                const qrCodeDataURL = await QRCode.toDataURL(qr);
                socket.emit('qr-code', qrCodeDataURL);
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log(`🔄 Reconectando usuário ${userId}...`);
                    setTimeout(() => connectToWhatsApp(userId, socket), 3000);
                } else {
                    // Marcar sessão como inativa
                    await pool.execute('UPDATE whatsapp_sessions SET is_active = FALSE WHERE user_id = ?', [userId]);
                    socket.emit('connection-status', { connected: false, message: 'Desconectado do WhatsApp' });
                }
            } else if (connection === 'open') {
                console.log(`✅ Usuário ${userId} conectado ao WhatsApp!`);
                
                // Salvar informações do WhatsApp
                const whatsappInfo = {
                    name: sock.user.name,
                    number: sock.user.id,
                    profilePicture: sock.user.imgUrl
                };
                
                await pool.execute(
                    'UPDATE whatsapp_sessions SET whatsapp_info = ?, is_active = TRUE WHERE user_id = ?',
                    [JSON.stringify(whatsappInfo), userId]
                );
                
                socket.emit('connection-status', { 
                    connected: true, 
                    whatsappInfo: whatsappInfo 
                });
            }
        });

        // Salvar sessão ativa
        userSessions.set(userId, {
            sock,
            isConnected: false,
            userId: userId
        });

    } catch (error) {
        console.error(`❌ Erro ao conectar WhatsApp para usuário ${userId}:`, error);
        socket.emit('error', 'Erro ao conectar WhatsApp');
    }
}

// Função para carregar grupos do usuário
async function loadUserGroups(userId, socket) {
    try {
        const userSession = userSessions.get(userId);
        if (!userSession || !userSession.sock || !userSession.isConnected) {
            socket.emit('error', 'WhatsApp não conectado');
            return;
        }

        console.log(`📋 Carregando grupos para usuário ${userId}...`);
        
        const groups = await userSession.sock.groupFetchAllParticipating();
        const userGroups = [];

        for (const [groupId, group] of Object.entries(groups)) {
            // Filtrar comunidades e grupos privados
            const isCommunity = group.endOfHistoryTransparencyDenied || 
                               group.participants.length > 1000 ||
                               group.name.toLowerCase().includes('comunidade') ||
                               group.name.includes('🏘️') ||
                               group.name.includes('🏠');

            const isPrivateGroup = !group.canSendMessages;

            if (!isCommunity && !isPrivateGroup) {
                const groupData = {
                    id: groupId,
                    name: group.name,
                    participants: group.participants.length,
                    canSendMessages: group.canSendMessages
                };

                userGroups.push(groupData);

                // Salvar no banco
                await pool.execute(
                    `INSERT INTO user_groups (user_id, group_id, group_name, participants, can_send_messages) 
                     VALUES (?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                     group_name = VALUES(group_name), 
                     participants = VALUES(participants),
                     can_send_messages = VALUES(can_send_messages),
                     updated_at = CURRENT_TIMESTAMP`,
                    [userId, groupId, group.name, group.participants.length, group.canSendMessages]
                );
            }
        }

        console.log(`✅ ${userGroups.length} grupos carregados para usuário ${userId}`);
        socket.emit('groups-loaded', userGroups);

    } catch (error) {
        console.error(`❌ Erro ao carregar grupos para usuário ${userId}:`, error);
        socket.emit('error', 'Erro ao carregar grupos');
    }
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token de acesso necessário' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
}

// Rotas de autenticação
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, recoveryQuestion, recoveryAnswer } = req.body;

        // Verificar se usuário já existe
        const [existingUsers] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ error: 'Telefone já cadastrado' });
        }

        // Criptografar senha
        const hashedPassword = await bcrypt.hash(password, 10);
        const hashedAnswer = await bcrypt.hash(recoveryAnswer, 10);

        // Criar usuário
        const [result] = await pool.execute(
            'INSERT INTO users (phone, password, recovery_question, recovery_answer) VALUES (?, ?, ?, ?)',
            [phone, hashedPassword, recoveryQuestion, hashedAnswer]
        );

        const userId = result.insertId;
        const token = jwt.sign({ userId, phone }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            success: true, 
            token, 
            user: { id: userId, phone } 
        });

    } catch (error) {
        console.error('Erro no cadastro:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        // Buscar usuário
        const [users] = await pool.execute('SELECT * FROM users WHERE phone = ?', [phone]);
        if (users.length === 0) {
            return res.status(401).json({ error: 'Telefone ou senha incorretos' });
        }

        const user = users[0];

        // Verificar senha
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Telefone ou senha incorretos' });
        }

        const token = jwt.sign({ userId: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            success: true, 
            token, 
            user: { id: user.id, phone: user.phone } 
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// WebSocket com autenticação
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
        return next(new Error('Token de autenticação necessário'));
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return next(new Error('Token inválido'));
        }
        
        socket.userId = decoded.userId;
        socket.userPhone = decoded.phone;
        next();
    });
});

io.on('connection', (socket) => {
    const userId = socket.userId;
    const userPhone = socket.userPhone;
    
    console.log(`👤 Usuário conectado: ${userPhone} (ID: ${userId})`);

    // Eventos do WhatsApp
    socket.on('connect-whatsapp', () => {
        connectToWhatsApp(userId, socket);
    });

    socket.on('load-groups', () => {
        loadUserGroups(userId, socket);
    });

    socket.on('disconnect', () => {
        console.log(`👤 Usuário desconectado: ${userPhone} (ID: ${userId})`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor com banco de dados rodando na porta ${PORT}`);
    console.log(`📊 Banco de dados: ${dbConfig.database}`);
});
