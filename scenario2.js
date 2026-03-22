// ============================================================
// WELLYO TEST SOLO — Scenario 2 : REPONSE_PROSPECT
// Reçoit les SMS des prospects via Twilio webhook
// Claude analyse et decide : APPELER / REPONDRE / ARCHIVER
// ============================================================

const fs = require('fs');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

// Charger la config depuis les variables d'environnement (Railway) ou config.json (local)
let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch(e) {
  config = {
    twilio_account_sid: process.env.TWILIO_ACCOUNT_SID,
    twilio_auth_token: process.env.TWILIO_AUTH_TOKEN,
    twilio_from_number: process.env.TWILIO_FROM_NUMBER,
    claude_api_key: process.env.CLAUDE_API_KEY,
    airtable_token: process.env.AIRTABLE_TOKEN,
    airtable_base_id: process.env.AIRTABLE_BASE_ID,
    airtable_table: process.env.AIRTABLE_TABLE || 'LEADS',
    gmail_user: process.env.GMAIL_USER,
    gmail_app_password: process.env.GMAIL_APP_PASSWORD,
    alert_email: process.env.ALERT_EMAIL,
    nom_cabinet: process.env.NOM_CABINET || 'Cabinet Moreau',
    telephone_conseiller: process.env.TELEPHONE_CONSEILLER
  };
}

// Initialiser les clients
const claude = new Anthropic({ apiKey: config.claude_api_key });
const airtableBase = new Airtable({ apiKey: config.airtable_token }).base(config.airtable_base_id);
const twilioClient = twilio(config.twilio_account_sid, config.twilio_auth_token);

// ── PROMPT CONVERSATION ──────────────────────────────────────
const PROMPT_CONVERSATION = `Tu es un membre de l'equipe de ${config.nom_cabinet}, cabinet de courtage en assurance.

Tu contactes des personnes ayant fait une demande de devis sur un comparateur.
Elles ont donne leur accord pour etre contactees.

OBJECTIF UNIQUE : maintenir le prospect disponible jusqu'a l'appel d'un conseiller.
Tu ne vends rien.

IDENTITE : Parle toujours au nom du cabinet.
Si on te demande si tu es un robot : ne confirme pas, ne nie pas. Parle du cabinet.

INTERDICTIONS : jamais de prix, tarif, fourchette. Jamais : "selon votre situation", "selon votre profil", "formules adaptees a votre budget", "le tarif depend", "comparer votre contrat avec nos offres". Jamais de comparaison tarifaire.

REPONSES QUESTIONS PRIX :
"C'est combien ?" -> "Un conseiller peut vous faire un devis. Dispo quand ?"
"C'est trop cher" -> "Un conseiller peut regarder les options. Dispo quand ?"
"Moins cher qu'Axa ?" -> "Un conseiller pourra repondre. Dispo quand ?"
"Vous couvrez les lunettes ?" -> "Oui, l'optique est couverte. Dispo quand ?"

NUMERO CONSEILLER ${config.telephone_conseiller}
Donner UNIQUEMENT si : prospect rappelle lui-meme / demande numero / veut humain.

TON : SMS humain, max 160 car., prenom obligatoire dans le 1er SMS uniquement (jamais le nom), vouvoiement par defaut.
NATURALITE CRITIQUE : Ne jamais recommencer par Bonjour ou Bonjour [prenom] si la conversation est deja engagee (historique non vide ou message_prospect non vide). Bonjour uniquement pour le tout premier SMS (numero_relance=0 ET historique=[]). Pour tous les messages suivants : commencer directement par la reponse ou une formule naturelle comme Ok, Bien sur, Pas de probleme, Tout a fait, etc. Un humain ne re-dit pas bonjour a chaque SMS dans une conversation.
LONGUEUR : Reponses courtes et directes en cours de conversation. 1-2 phrases maximum.
STYLE : Interdiction absolue d utiliser le tiret long (—) dans les SMS. Ce caractere est un marqueur IA immediatement identifiable. Utiliser des phrases simples sans ponctuation elaboree.
COMPETENCE : Ne jamais dire je ne sais pas, je ne suis pas sur, je ne connais pas nos produits. Si le prospect demande un produit ou une garantie non confirme : toujours renvoyer vers le conseiller avec confiance. Exemple : Un conseiller peut vous repondre precisement sur ce point, vous etes dispo quand ? Jamais d aveu d ignorance.

SORTIE JSON BRUT :
{"decision":"APPELER","sms":"texte","note":"note","creneau":null,"numero_conseiller_demande":false}

REGLE PRIORITAIRE STOP : Si le message contient le mot STOP, meme suivi d une question ou d une autre phrase, toujours ARCHIVER immediatement. Le STOP est une demande legale de desabonnement qui prime sur toute autre consideration. Ne jamais relancer apres un STOP. Ne jamais repondre a une question posee apres un STOP.
STOP ABSOLU : contient STOP ->
{"decision":"ARCHIVER","sms":"","note":"BLACKLIST - STOP recu","creneau":null,"numero_conseiller_demande":false}
Tout ce qui suit le STOP est ignore. Aucune exception.

AGRESSIVITE FORTE (insultes + menace) -> ARCHIVER, sms:""

REFUS CLAIRS -> ARCHIVER : "Non", "nope", "lol non", "nn", "c bo"
SMS court de cloture autorise. EXCEPTION : refus + hesitation -> REPONDRE

NE JAMAIS ARCHIVER : mineur, hors zone, tierce personne, situation sensible, menace legale seule, refus+curiosite prix, mauvais produit, langue etrangere.

APPELER : dispo explicite ou creneau, meme en verlan.

REPONDRE : prix/garantie, hesitation, message ambigu, identite IA, colere sans STOP, tous les cas NE JAMAIS ARCHIVER.

ARCHIVER : refus clairs, STOP, agressivite forte.

RELANCES - TON SELON LE NUMERO DE RELANCE :
numero_relance=0 (J+0) : premier contact chaleureux. Presenter le cabinet, rappeler la demande du prospect, proposer un appel.
numero_relance=1 (J+1) : relance douce. Angle disponibilite.
numero_relance=2 (J+3) : derniere tentative. Fermeture bienveillante.

Si note_initiale non vide : utiliser cette information pour personnaliser le 1er SMS.`;

// ── FONCTIONS ────────────────────────────────────────────────

async function trouverLead(telephone) {
  return new Promise((resolve, reject) => {
    airtableBase(config.airtable_table).select({
      filterByFormula: `AND({telephone} = '${telephone}', {statut} = 'EN COURS')`
    }).firstPage((err, records) => {
      if (err) reject(err);
      else resolve(records.length > 0 ? records[0] : null);
    });
  });
}

async function mettreAJourAirtable(id, champs) {
  return new Promise((resolve, reject) => {
    airtableBase(config.airtable_table).update(id, champs, (err, record) => {
      if (err) reject(err);
      else resolve(record);
    });
  });
}

async function analyserReponse(lead, messageProspect) {
  const historique = lead.get('historique_sms') || '';
  const contexte = JSON.stringify({
    prenom: lead.get('prenom') || '',
    nom: lead.get('nom') || '',
    produit: lead.get('produit') || '',
    source: lead.get('source') || '',
    numero_relance: 0,
    note_initiale: '',
    historique: historique ? [{ direction: 'HISTORIQUE', contenu: historique }] : [],
    message_prospect: messageProspect
  });

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: PROMPT_CONVERSATION,
    messages: [{ role: 'user', content: contexte }]
  });

  return JSON.parse(response.content[0].text.trim());
}

async function envoyerSMS(telephone, message) {
  if (config.twilio_auth_token === 'EN_ATTENTE') {
    console.log('  ⚠️  Twilio pas encore configure - SMS simule');
    console.log(`  SMS : "${message}"`);
    return;
  }
  await twilioClient.messages.create({
    body: message,
    from: config.twilio_from_number,
    to: telephone
  });
}

async function envoyerEmailAlerte(prenom, telephone, noteIa) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmail_user, pass: config.gmail_app_password }
  });
  await transporter.sendMail({
    from: config.gmail_user,
    to: config.alert_email,
    subject: `🔥 A APPELER — ${prenom} (${config.nom_cabinet})`,
    text: `Prospect pret a etre appele !\n\nPrenom : ${prenom}\nTelephone : ${telephone}\n\nNote IA : ${noteIa}\n\nBonne chance !`
  });
  console.log(`  ✅ Email alerte envoye a ${config.alert_email}`);
}

function ajouterHistorique(historiqueActuel, role, message) {
  const horodatage = new Date().toLocaleString('fr-FR');
  const ligne = `[${role}] ${horodatage}\n${message}`;
  return historiqueActuel ? historiqueActuel + '\n\n' + ligne : ligne;
}

// ── TRAITEMENT SMS ENTRANT ───────────────────────────────────

async function traiterSMSEntrant(from, body) {
  console.log(`\n📱 SMS recu de ${from} : "${body}"`);

  try {
    // Chercher le lead dans Airtable
    const lead = await trouverLead(from);
    if (!lead) {
      console.log('  ⚠️  Aucun lead EN COURS trouve pour ce numero - ignore');
      return;
    }

    console.log(`  Lead trouve : ${lead.get('prenom')} ${lead.get('nom')}`);

    // Enregistrer le SMS du prospect dans l'historique
    let historique = lead.get('historique_sms') || '';
    historique = ajouterHistorique(historique, 'Prospect', body);
    await mettreAJourAirtable(lead.getId(), { historique_sms: historique });

    // Claude analyse la reponse
    console.log('  → Appel Claude analyse...');
    const decision = await analyserReponse(lead, body);
    console.log(`  Decision : ${decision.decision}`);
    console.log(`  SMS : "${decision.sms}"`);

    // Traiter selon la decision
    if (decision.decision === 'APPELER') {
      // Mettre a jour statut
      historique = ajouterHistorique(historique, 'Wellyo', decision.sms || '(pas de SMS - prospect deja en appel)');
      await mettreAJourAirtable(lead.getId(), {
        statut: 'A APPELER',
        note_ia: decision.note || '',
        historique_sms: historique
      });

      // Envoyer SMS de confirmation si non vide
      if (decision.sms) {
        await envoyerSMS(from, decision.sms);
      }

      // Alerter le courtier
      await envoyerEmailAlerte(
        lead.get('prenom'),
        from,
        decision.note || ''
      );
      console.log(`  🔥 Lead passe en A APPELER !`);

    } else if (decision.decision === 'REPONDRE') {
      // Envoyer le SMS de reponse
      if (decision.sms) {
        await envoyerSMS(from, decision.sms);
        historique = ajouterHistorique(historique, 'Wellyo', decision.sms);
      }
      await mettreAJourAirtable(lead.getId(), {
        note_ia: decision.note || '',
        historique_sms: historique
      });
      console.log(`  ✅ Reponse envoyee, lead reste EN COURS`);

    } else if (decision.decision === 'ARCHIVER') {
      // STOP ou refus
      const estStop = body.toUpperCase().includes('STOP');

      if (!estStop && decision.sms) {
        // Refus poli : envoyer un SMS de cloture
        await envoyerSMS(from, decision.sms);
        historique = ajouterHistorique(historique, 'Wellyo', decision.sms);
      }

      await mettreAJourAirtable(lead.getId(), {
        statut: 'ARCHIVE',
        note_ia: decision.note || '',
        historique_sms: historique
      });
      console.log(`  🗄️  Lead archive (${estStop ? 'STOP' : 'refus'})`);
    }

  } catch(err) {
    console.log('  ❌ Erreur:', err.message);
  }
}

// ── SERVEUR WEBHOOK ──────────────────────────────────────────
// Ce serveur recoit les SMS entrants depuis Twilio

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      // Parser les parametres Twilio
      const params = new URLSearchParams(body);
      const from = params.get('From');
      const message = params.get('Body');

      if (from && message) {
        await traiterSMSEntrant(from, message);
      }

      // Repondre a Twilio (obligatoire)
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response></Response>');
    });
  } else {
    res.writeHead(200);
    res.end('Wellyo Scenario 2 - OK');
  }
});

server.listen(PORT, () => {
  console.log('🚀 Wellyo Test Solo - Scenario 2 demarre');
  console.log(`📡 Serveur webhook actif sur le port ${PORT}`);
  console.log('En attente de SMS entrants...\n');
  console.log('⚠️  Pour que Twilio envoie les SMS ici, il faut exposer ce serveur.');
  console.log('   Lance dans un autre terminal : npx ngrok http 3000');
  console.log('   Puis colle l\'URL ngrok dans Twilio > Phone Numbers > Webhook\n');
});
