const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios')

const app = express()
app.use(bodyParser.json())

let sock

// N8N Webhook URL - ganti dengan URL n8n webhook Anda
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://your-n8n-webhook-url.com/webhook/whatsapp-task'

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    sock = makeWASocket({
    auth: state
})

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect)
            
            if(shouldReconnect) {
                connectToWhatsApp()
            }
        } else if(connection === 'open') {
            console.log('✅ WhatsApp Bot Connected!')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0]
        
        if (!message.key.fromMe && m.type === 'notify') {
            const from = message.key.remoteJid
            const messageText = message.message?.conversation || 
                              message.message?.extendedTextMessage?.text || ''
            
            console.log(`📩 Message from ${from}: ${messageText}`)
            
            // Forward to n8n webhook
            try {
                const webhookData = {
                    from: from,
                    message: messageText,
                    timestamp: new Date().toISOString(),
                    messageId: message.key.id
                }
                
                // Send to n8n
                const response = await axios.post(N8N_WEBHOOK_URL, webhookData)
                console.log('✅ Sent to n8n:', response.status)
                
            } catch (error) {
                console.error('❌ Error sending to n8n:', error.message)
            }
        }
    })
}

// Endpoint untuk n8n kirim reply
app.post('/send-message', async (req, res) => {
    try {
        const { to, message } = req.body
        
        await sock.sendMessage(to, { text: message })
        
        console.log(`📤 Reply sent to ${to}: ${message}`)
        res.json({ status: 'success', message: 'Message sent' })
        
    } catch (error) {
        console.error('❌ Error sending message:', error)
        res.status(500).json({ status: 'error', message: error.message })
    }
})

// Health check endpoint
app.get('/status', (req, res) => {
    res.json({ 
        status: 'running',
        connected: sock?.user ? true : false,
        user: sock?.user
    })
})

// Start server
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`)
    console.log(`📱 WhatsApp Bot starting...`)
    connectToWhatsApp()
})

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...')
    if (sock) {
        await sock.logout()
    }
    process.exit(0)
})
