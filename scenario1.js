// ============================================================
// WELLYO TEST SOLO — Scenario 1 : LEAD_ENTRANT
// Surveille Gmail, parse avec Claude, cree Airtable, envoie SMS
// ============================================================

const fs = require('fs');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
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

// IDs des emails déjà traités (pour éviter les doublons)
const emailsTraites = new Set();

// ── PROMPT PARSING EMAIL ──────────────────────────────────────
const PROMPT_PARSING = `Tu es un extracteur de donnees. Tu recois le corps d'un email de lead assurance envoye par un comparateur (Assurland, LeLynx, LesFurets, etc.).

Ton unique role : extraire les informations du prospect en JSON brut.
Zero texte avant ou apres. Zero markdown.

FORMAT :
{
  "prenom": "prenom ou null",
  "nom": "nom de famille ou null",
  "telephone": "E.164 ex: +33612345678 ou null",
  "produit": "ex: mutuelle sante, assurance auto ou null",
  "source": "ex: Assurland, LeLynx ou null"
}

REGLES :
- prenom : premier prenom uniquement
- nom : nom de famille uniquement, sans le prenom
- telephone : format E.164. 06 12 34 56 78 -> +33612345678. Si plusieurs numeros : mobile (06/07) en priorite
- produit : en minuscules
- source : depuis expediteur, sujet ou corps
- Information absente : null. Ne jamais inventer.

Reponds UNIQUEMENT avec le JSON.`;

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

async function parserEmail(corpsEmail) {
  console.log('  → Appel Claude parsing...');
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: PROMPT_PARSING,
    messages: [{ role: 'user', content: corpsEmail }]
  });
  const texte = response.content[0].text.trim();
  return JSON.parse(texte);
}

async function genererSMS(prenom, nom, produit, source) {
  console.log('  → Appel Claude conversation...');
  const contexte = JSON.stringify({
    prenom, nom, produit, source,
    numero_relance: 0,
    note_initiale: '',
    historique: [],
    message_prospect: ''
  });
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: PROMPT_CONVERSATION,
    messages: [{ role: 'user', content: contexte }]
  });
  const texte = response.content[0].text.trim();
  return JSON.parse(texte);
}

async function creerFicheAirtable(data) {
  console.log('  → Creation fiche Airtable...');
  return new Promise((resolve, reject) => {
    airtableBase(config.airtable_table).create([{
      fields: {
        prenom: data.prenom || '',
        nom: data.nom || '',
        telephone: data.telephone || '',
        produit: data.produit || '',
        source: data.source || '',
        statut: data.statut || 'EN COURS',
        note_ia: data.note_ia || '',
        timestamp_premier_sms: data.timestamp_premier_sms || '',
        email_brut: data.email_brut || '',
        historique_sms: data.historique_sms || ''
      }
    }], (err, records) => {
      if (err) reject(err);
      else resolve(records[0]);
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

async function envoyerSMS(telephone, message) {
  console.log(`  → Envoi SMS vers ${telephone}...`);
  if (config.twilio_auth_token === 'EN_ATTENTE' || config.twilio_from_number === 'EN_ATTENTE') {
    console.log('  ⚠️  Twilio pas encore configure - SMS simule uniquement');
    console.log(`  SMS qui aurait ete envoye : "${message}"`);
    return null;
  }
  return twilioClient.messages.create({
    body: message,
    from: config.twilio_from_number,
    to: telephone
  });
}

async function envoyerEmailAlerte(prenom, telephone, noteIa) {
  console.log('  → Envoi email alerte A APPELER...');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.gmail_user,
      pass: config.gmail_app_password
    }
  });
  await transporter.sendMail({
    from: config.gmail_user,
    to: config.alert_email,
    subject: `🔥 A APPELER — ${prenom} (${config.nom_cabinet})`,
    text: `Prospect pret a etre appele !\n\nPrenom : ${prenom}\nTelephone : ${telephone}\n\nNote IA : ${noteIa}\n\nBonne chance !`
  });
}

async function traiterEmail(email) {
  console.log('\n📧 Nouvel email detecte !');
  
  try {
    // Parser le contenu de l'email
    const parsed = await simpleParser(email.body);
    const corpsEmail = parsed.text || parsed.html || '';
    const sujet = parsed.subject || '';
    
    console.log(`  Sujet: ${sujet}`);
    
    // Etape 1 : Claude parse l'email
    let leadData;
    try {
      leadData = await parserEmail(corpsEmail + '\nSujet: ' + sujet);
    } catch(e) {
      console.log('  ❌ Erreur parsing Claude:', e.message);
      return;
    }
    
    console.log(`  Lead extrait: ${leadData.prenom} ${leadData.nom} - ${leadData.telephone}`);
    
    // Etape 2 : Verifier si telephone present
    if (!leadData.telephone) {
      console.log('  ⚠️  Pas de telephone - statut PARSING_INCOMPLET');
      await creerFicheAirtable({
        ...leadData,
        statut: 'PARSING_INCOMPLET',
        email_brut: corpsEmail
      });
      return;
    }
    
    // Etape 3 : Creer la fiche Airtable
    const fiche = await creerFicheAirtable({
      ...leadData,
      statut: 'EN COURS',
      email_brut: corpsEmail
    });
    console.log(`  ✅ Fiche Airtable creee : ${fiche.getId()}`);
    
    // Etape 4 : Claude genere le SMS
    let smsData;
    try {
      smsData = await genererSMS(leadData.prenom, leadData.nom, leadData.produit, leadData.source);
    } catch(e) {
      console.log('  ❌ Erreur generation SMS:', e.message);
      return;
    }
    
    console.log(`  Decision Claude: ${smsData.decision}`);
    console.log(`  SMS: "${smsData.sms}"`);
    
    // Etape 5 : Envoyer le SMS
    if (smsData.sms) {
      await envoyerSMS(leadData.telephone, smsData.sms);
    }
    
    // Etape 6 : Mettre a jour Airtable
    const maintenant = new Date().toISOString();
    const horodatage = new Date().toLocaleString('fr-FR');
    const premierSms = smsData.sms ? '[J+0 - Wellyo] ' + horodatage + '\n' + smsData.sms : '';
    await mettreAJourAirtable(fiche.getId(), {
      note_ia: smsData.note || '',
      timestamp_premier_sms: maintenant,
      historique_sms: premierSms
    });
    
    // Etape 7 : Si APPELER direct (rare au J+0 mais possible)
    if (smsData.decision === 'APPELER') {
      await mettreAJourAirtable(fiche.getId(), { statut: 'A APPELER' });
      await envoyerEmailAlerte(leadData.prenom, leadData.telephone, smsData.note);
    }
    
    console.log(`  ✅ Lead traite avec succes !`);
    
  } catch(err) {
    console.log('  ❌ Erreur:', err.message);
  }
}

async function surveillerGmail() {
  console.log('🚀 Wellyo Test Solo - Scenario 1 demarre');
  console.log(`📬 Surveillance de : ${config.gmail_user}`);
  console.log('En attente de nouveaux emails...\n');
  
  const imapConfig = {
    imap: {
      user: config.gmail_user,
      password: config.gmail_app_password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000
    }
  };
  
  // Verifier les nouveaux emails toutes les 30 secondes
  setInterval(async () => {
    try {
      const connection = await imaps.connect(imapConfig);
      await connection.openBox('INBOX');
      
      const depuis = new Date();
      depuis.setMinutes(depuis.getMinutes() - 1); // Emails de la derniere minute
      
      const emails = await connection.search(['UNSEEN'], {
        bodies: [''],
        markSeen: true
      });
      
      for (const email of emails) {
        const uid = email.attributes.uid;
        if (!emailsTraites.has(uid)) {
          emailsTraites.add(uid);
          await traiterEmail({ body: email.parts[0].body });
        }
      }
      
      await connection.end();
    } catch(err) {
      if (!err.message.includes('Nothing to do')) {
        console.log('Erreur connexion Gmail:', err.message);
      }
    }
  }, 30000); // Toutes les 30 secondes
}

// Lancer le script
surveillerGmail();
