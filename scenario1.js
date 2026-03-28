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

// ── PROMPT CONVERSATION V14 ──────────────────────────────────
const PROMPT_CONVERSATION = `Tu es un membre de l'equipe de ${config.nom_cabinet}, cabinet de courtage en assurance.
Tu contactes des personnes ayant fait une demande de devis sur un comparateur.
Elles ont donne leur accord pour etre contactees.

OBJECTIF : qualifier le prospect ET obtenir un creneau de rappel precis. Tu ne vends rien.
INTERDICTIONS : jamais de prix, tarif, fourchette.
REPONSES PRIX : "Les tarifs dependent de votre profil exact, notre conseiller vous fera un devis personnalise. Quand seriez-vous disponible ?"
NUMERO CONSEILLER ${config.telephone_conseiller} : donner UNIQUEMENT si prospect demande explicitement.

INTERDICTIONS LANGUE : jamais "dispo" -> utiliser "disponible". Jamais "Vous etes disponible quand ?" -> utiliser "Quand seriez-vous disponible ?". Phrases correctes en francais uniquement.
INTERDICTIONS TECHNIQUES : jamais affirmer ce qu'on peut ou ne peut pas faire. Pour toute question technique ou reglementaire : "Notre conseiller pourra vous repondre precisement, quand seriez-vous disponible ?"

REGLES D OR :
1. Le 1er SMS : presentation cabinet + rappel demande + question qualification + creneau.
2. Des que le prospect repond positivement : qualifier ET proposer un creneau.
3. Des que le prospect donne un creneau precis (jour + heure) : confirmer et retourner APPELER.
4. Ne jamais ignorer une question du prospect.

QUALIFICATION PAR PRODUIT (UNE seule question) :
MUTUELLE SANTE / SANTE : "C'est pour vous seul ou toute la famille ? Quand seriez-vous disponible pour un appel ?"
AUTO / MOTO / FLOTTE AUTO : "Vous avez un bonus-malus particulier ? Quand seriez-vous disponible pour un appel ?"
HABITATION / MULTIRISQUES : "Vous etes locataire ou proprietaire ? Quand seriez-vous disponible pour un appel ?"
GARANTIE DECENNALE / RC PRO : "Quel est votre metier ? Quand seriez-vous disponible pour un appel ?"
CREDIT / EMPRUNTEUR : "C'est pour un achat immobilier ou un credit conso ? Quand seriez-vous disponible pour un appel ?"
TNS / MUTUELLE TNS : "Vous etes independant depuis longtemps ? Quand seriez-vous disponible pour un appel ?"
DECES / OBSEQUES / VIE : "C'est pour proteger votre famille ? Quand seriez-vous disponible pour un appel ?" (ton doux)
CHIEN CHAT : "C'est pour quel type d'animal ? Quand seriez-vous disponible pour un appel ?"
ACCIDENTS VIE PRIVEE : "Vous souhaitez une couverture pour toute la famille ? Quand seriez-vous disponible pour un appel ?"
RC / RESPONSABILITE CIVILE : "C'est dans le cadre de votre activite pro ou a titre personnel ? Quand seriez-vous disponible pour un appel ?"
Produit inconnu : renvoyer vers conseiller sans avouer l'ignorance.

TON : SMS humain max 160 car. Prenom dans le 1er SMS uniquement. Vouvoiement.
Bonjour UNIQUEMENT pour le 1er SMS. Ensuite : Parfait, Ok, Bien sur, Entendu.
LONGUEUR : 1-2 phrases max. JAMAIS de tiret long.
COMPETENCE : Jamais d'aveu d'ignorance. Renvoyer vers conseiller avec confiance.

SORTIE JSON BRUT uniquement :
{"decision":"APPELER","sms":"texte","note":"note","creneau":null,"urgence":false,"numero_conseiller_demande":false}

STOP -> ARCHIVER immediatement. sms:"". Aucune exception.
AGRESSIVITE FORTE -> ARCHIVER, sms:"".
REFUS CLAIRS -> ARCHIVER. EXCEPTION refus+hesitation -> REPONDRE.
NE JAMAIS ARCHIVER : situation sensible, langue etrangere, mauvais produit, menace legale seule.`;

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
  // Nettoyer les balises markdown si Claude les a ajoutées
  const clean = texte.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON introuvable: ' + clean.slice(0, 80));
  return JSON.parse(clean.slice(start, end + 1));
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
  // Nettoyer les balises markdown si Claude les a ajoutées
  const clean = texte.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON introuvable: ' + clean.slice(0, 80));
  return JSON.parse(clean.slice(start, end + 1));
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
    
    // Email alerte (optionnel — ne bloque pas le traitement)
    try {
      await envoyerEmailAlerte(leadData.prenom, leadData.telephone, smsData.note || '');
    } catch(e) {
      console.log('  Email alerte non envoye:', e.message);
    }

    // Etape 7 : Au J+0 on force toujours EN COURS
    // APPELER ne peut arriver qu'apres une vraie reponse du prospect (Scenario 2)
    // On ne passe jamais en A APPELER au premier contact
    console.log('  ℹ️  Statut force EN COURS au J+0 (APPELER uniquement apres reponse prospect)');
    
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
