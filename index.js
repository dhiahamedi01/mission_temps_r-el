const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const webpush = require('web-push');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Configuration PostgreSQL
const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

// Création du serveur HTTP et Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
  },
});

// Clés VAPID
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

webpush.setVapidDetails(
  process.env.VAPID_MAILTO,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Abonnements push
let subscriptions = [];

app.get('/vapidPublicKey', (req, res) => {
  res.send(vapidKeys.publicKey);
});

app.post('/api/save-subscription', (req, res) => {
  const subscription = req.body;
  if (!subscriptions.find(sub => JSON.stringify(sub) === JSON.stringify(subscription))) {
    subscriptions.push(subscription);
    console.log('✅ Abonnement push enregistré');
  }
  res.status(201).json({ message: 'Abonnement enregistré' });
});

async function sendPushNotification(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    console.log('📤 Notification push envoyée');
  } catch (error) {
    console.error('❌ Erreur envoi notification push :', error);
  }
}

// Configuration WhatsApp API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

async function sendWhatsAppMessage(to, message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ Message WhatsApp envoyé :', response.data);
  } catch (error) {
    console.error('❌ Erreur envoi WhatsApp :', error.response?.data || error.message);
  }
}

// Socket.IO
io.on('connection', (socket) => {
  console.log('✅ Client connecté via Socket.IO');

  socket.on('createMission', async (data) => {
    try {
      const {
        dateDebut,
        dateFin,
        description,
        chauffeurId,
        transporteurId,
        kilometrageArrive = 0,
        kilometrageDebut = 0,
        statut = 'Mission créée',
        devisId,
        vehiculeId,
      } = data;

      const result = await pool.query(
        `INSERT INTO mission_table 
        (date_debut, date_fin, description, id_chauffeur, id_transpoteur, kilometrage_arrive, kilometrage_debut, statut, created_at, updated_at, devis_id, vehicule_id)
        VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10)
        RETURNING *`,
        [
          dateDebut,
          dateFin,
          description,
          chauffeurId,
          transporteurId,
          kilometrageArrive,
          kilometrageDebut,
          statut,
          devisId,
          vehiculeId,
        ]
      );

      const mission = result.rows[0];
      console.log('📝 Mission créée:', mission);

      // 🔔 Notifier via Socket.IO
      io.emit(`notifChauffeur_${chauffeurId}`, {
        message: `Nouvelle mission créée avec le numéro ${mission.id}`,
        missionId: mission.id,
        mission
      });

      // 🔔 Notification push
      const payload = {
        title: 'Nouvelle mission',
        body: 'Une nouvelle mission vous a été attribuée.',
        data: { url: '/missions' }
      };
      subscriptions.forEach(sub => sendPushNotification(sub, payload));

      // ✅ Envoi WhatsApp à un numéro fixe
      const fixedPhone = '21658216611';
      const message = `🚚 Nouvelle mission :

📝 Description : ${description}
📅 Début : ${dateDebut}
📅 Fin : ${dateFin}
🚛 Véhicule : ${vehiculeId}
📌 Statut : ${statut}

Merci de vérifier votre mission.`;

      await sendWhatsAppMessage(fixedPhone, message);

      socket.emit('missionCreated', mission);
    } catch (error) {
      console.error('❌ Erreur création mission:', error);
      socket.emit('errorMission', { message: 'Erreur lors de la création de la mission.' });
    }
  });

  socket.on('disconnect', () => {
    console.log('👋 Client déconnecté');
  });
});

// ▶️ Démarrage serveur
server.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
