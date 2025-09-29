import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode';
import authRoutes from './routes/auth.js';
import { authenticateToken } from './routes/auth.js';
import db from './config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rotas de autenticação
app.use('/api/auth', authRoutes);

// Middleware para verificar autenticação
app.use('/api/*', authenticateToken);

// Armazenar sessões dos usuários
const userSessions = new Map();

// Função para criar socket WhatsApp
async function createWhatsAppSocket(userId, sessionId = 'default') {
    const authDir = `auth_info_${userId}_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['DisparoZap', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrCode = await qrcode.toDataURL(qr);
            io.to(`user_${userId}`).emit('qr-code', qrCode);
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => createWhatsAppSocket(userId, sessionId), 3000);
            }
        } else if (connection === 'open') {
            console.log(`✅ WhatsApp conectado para usuário ${userId}`);
            io.to(`user_${userId}`).emit('connection-status', { connected: true });
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    return sock;
}

// Socket.io events
io.on('connection', (socket) => {
    console.log(`👤 Cliente conectado: ${socket.id}`);
    
    socket.on('join-user', async (data) => {
        const { userId } = data;
        socket.join(`user_${userId}`);
        console.log(`👤 Usuário ${userId} entrou na sala`);
    });

    socket.on('connect-whatsapp', async (data = {}) => {
        const { userId, accountId, sessionId = 'default' } = data;
        const userIdentifier = userId || accountId || 'default';
        
        try {
            if (!userSessions.has(userIdentifier)) {
                userSessions.set(userIdentifier, {});
            }
            
            const sock = await createWhatsAppSocket(userIdentifier, sessionId);
            userSessions.get(userIdentifier)[sessionId] = {
                sock,
                isConnected: false,
                sessionId
            };
            
            console.log(`📱 Conectando WhatsApp para usuário ${userIdentifier}`);
        } catch (error) {
            console.error('Erro ao conectar WhatsApp:', error);
            socket.emit('connection-error', { message: 'Erro ao conectar WhatsApp' });
        }
    });

    socket.on('load-groups', async (data) => {
        const { userId, sessionId = 'default' } = data;
        
        try {
            const userSession = userSessions.get(userId);
            if (!userSession || !userSession[sessionId]) {
                socket.emit('groups-loaded', { groups: [] });
                return;
            }
            
            const { sock } = userSession[sessionId];
            const groups = await sock.groupFetchAllParticipating();
            
            const groupsList = Object.values(groups).map(group => ({
                id: group.id,
                name: group.subject,
                description: group.desc,
                participantCount: group.participants ? Object.keys(group.participants).length : 0,
                isCommunity: group.endOfHistoryTransparencyDenied || false,
                isPrivate: group.restrict || false
            })).filter(group => !group.isCommunity && !group.isPrivate);
            
            socket.emit('groups-loaded', { groups: groupsList });
        } catch (error) {
            console.error('Erro ao carregar grupos:', error);
            socket.emit('groups-loaded', { groups: [] });
        }
    });

    socket.on('disconnect', () => {
        console.log(`👤 Cliente desconectado: ${socket.id}`);
    });
});

// Rotas
app.get('/', (req, res) => {
    res.redirect('/home/');
});

app.get('/home/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor com banco de dados rodando em http://localhost:${PORT}`);
    console.log(`📱 Sistema de autenticação ativo!`);
    console.log(`🌐 Pronto para deploy online!`);
});