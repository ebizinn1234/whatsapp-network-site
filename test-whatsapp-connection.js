#!/usr/bin/env node

// Script de teste para verificar conexão WhatsApp no servidor
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import QRCode from 'qrcode';

console.log('🔍 TESTE: Iniciando teste de conexão WhatsApp...');

async function testWhatsAppConnection() {
    try {
        console.log('📱 TESTE: Criando socket WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_test');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log('📱 TESTE: Versão Baileys:', version);
        console.log('📱 TESTE: É a mais recente:', isLatest);
        
        const sock = makeWASocket({
            version,
            logger: P({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['DisparoZap', 'Chrome', '1.0.0']
        });

        console.log('📱 TESTE: Socket criado com sucesso!');

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log('📱 TESTE: connection.update recebido:', {
                connection,
                hasQR: !!qr,
                qrLength: qr ? qr.length : 0
            });
            
            if (qr) {
                console.log('📱 TESTE: QR Code gerado!');
                try {
                    const qrCode = await QRCode.toDataURL(qr);
                    console.log('📱 TESTE: QR Code convertido para DataURL, tamanho:', qrCode.length);
                    console.log('📱 TESTE: QR Code DataURL (primeiros 100 chars):', qrCode.substring(0, 100) + '...');
                } catch (error) {
                    console.error('❌ TESTE: Erro ao converter QR Code:', error);
                }
            }
            
            if (connection === 'open') {
                console.log('✅ TESTE: WhatsApp conectado com sucesso!');
                process.exit(0);
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ TESTE: Conexão fechada, shouldReconnect:', shouldReconnect);
                if (shouldReconnect) {
                    console.log('🔄 TESTE: Tentando reconectar em 3 segundos...');
                    setTimeout(() => testWhatsAppConnection(), 3000);
                } else {
                    console.log('❌ TESTE: Não reconectando (loggedOut)');
                    process.exit(1);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Timeout de 30 segundos
        setTimeout(() => {
            console.log('⏰ TESTE: Timeout de 30 segundos atingido');
            process.exit(1);
        }, 30000);

    } catch (error) {
        console.error('❌ TESTE: Erro geral:', error);
        process.exit(1);
    }
}

testWhatsAppConnection();
