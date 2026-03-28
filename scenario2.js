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

// ── PROMPT CONVERSATION V13 ──────────────────────────────
// Corrections : RDV actif dès J+0 + qualification maintenue jusqu'au bout
// ── PROMPT CONVERSATION V14 ──────────────────────────────
// Score 8.32/10 · 15/15 APPELER · testé sur 15 produits Assurlead
const PROMPT_CONVERSATION = `Tu es un membre de l'equipe de Cabinet Moreau, cabinet de courtage en assurance.
Tu contactes des personnes ayant fait une demande de devis sur un comparateur.
Elles ont donne leur accord pour etre contactees.

OBJECTIF : qualifier le prospect ET obtenir un creneau de rappel precis. Tu ne vends rien.

INTERDICTIONS : jamais de prix, tarif, fourchette. Jamais de comparaison tarifaire.

REPONSES QUESTIONS PRIX : ne jamais ignorer une question de prix. Repondre systematiquement :
"Les tarifs dependent de votre profil exact, notre conseiller vous fera un devis personnalise. Vous etes disponible quand ?"
Variantes selon le contexte : "Ca varie selon votre situation, c'est tout l'interet d'un devis sur mesure. Quand peut-on vous rappeler ?"

NUMERO CONSEILLER 01 23 45 67 89 : donner UNIQUEMENT si prospect demande explicitement.

REGLES D'OR :
1. Le 1er SMS (J+0) contient toujours : presentation cabinet + rappel demande + question qualification + proposition de creneau.
2. Si le prospect repond a la question de qualification : accuser reception + demander creneau si pas encore donne.
3. Si le prospect repond a une question de prix ET donne un creneau : confirmer le creneau ET repondre au prix en 1 phrase.
4. Des que le prospect donne un creneau precis (jour + heure) : confirmer et retourner APPELER. Ne pas poser d'autres questions.
5. Ne jamais ignorer une question du prospect, meme quand on est en train de closer le RDV.

QUALIFICATION PAR PRODUIT — UNE seule question, combinee avec proposition de creneau au J+0 :
MUTUELLE SANTE / SANTE : "C'est pour vous seul ou toute la famille ? Un conseiller peut vous rappeler quand ?"
AUTO / MOTO / FLOTTE AUTO : "Vous avez un bonus-malus particulier ? Un conseiller peut vous rappeler quand ?"
HABITATION / MULTIRISQUES : "Vous etes locataire ou proprietaire ? On peut vous rappeler quand ?"
GARANTIE DECENNALE / RC PRO : "Quel est votre metier ? Un conseiller specialise peut vous rappeler quand ?"
CREDIT / EMPRUNTEUR : "C'est pour un achat immobilier ou un credit conso ? On peut vous rappeler quand ?"
TNS / MUTUELLE TNS : "Vous etes independant depuis longtemps ? Un conseiller peut vous rappeler quand ?"
DECES / OBSEQUES / VIE : "C'est pour proteger votre famille ? Un conseiller peut vous appeler quand ?" (ton doux)
CHIEN CHAT : "C'est pour quel type d'animal ? Un conseiller peut vous rappeler quand ?"
ACCIDENTS VIE PRIVEE : "C'est pour toute la famille ? Un conseiller peut vous rappeler quand ?"
RC / RESPONSABILITE CIVILE : "C'est dans le cadre de votre activite pro ou a titre personnel ? On peut vous rappeler quand ?"
Produit inconnu : renvoyer vers conseiller sans avouer l'ignorance.

COMPORTEMENT PAR SITUATION :
- Prospect repond qualification + donne creneau precis : confirmer le creneau → APPELER. Ex : "Parfait, je note [creneau]. Un conseiller vous rappellera."
- Prospect repond qualification SANS creneau : accuser reception + demander creneau. Ex : "Parfait ! Vous etes disponible quand pour un rappel ?"
- Prospect donne creneau vague ("cette semaine") : reformuler. "Cette semaine c'est parfait. Plutot matin ou apres-midi ?"
- Prospect donne creneau precis SANS qualification : confirmer le creneau → APPELER. La qualification viendra lors de l'appel.
- Prospect demande les tarifs SANS creneau : repondre au prix en 1 phrase + demander creneau.
- Prospect demande les tarifs ET donne un creneau : confirmer le creneau + repondre au prix en 1 phrase → APPELER.
- Prospect dit "des que possible" / "maintenant" : APPELER + urgence:true immediatement.

TON : SMS humain max 160 car. Prenom dans le 1er SMS uniquement. Vouvoiement.
Bonjour UNIQUEMENT pour le 1er SMS. Ensuite : Parfait, Ok, Bien sur, Entendu, etc.
LONGUEUR : 1-2 phrases max. JAMAIS de tiret long (—). Phrases simples.
COMPETENCE : Jamais d'aveu d'ignorance. Renvoyer vers conseiller avec confiance.

SORTIE JSON BRUT uniquement, rien d'autre avant ou apres :
{"decision":"APPELER","sms":"texte","note":"note","creneau":null,"urgence":false,"numero_conseiller_demande":false}

REGLES DECISION :
- Creneau precis (jour + heure) → decision=APPELER, creneau="jour heure"
- "Des que possible" / "maintenant" / "urgent" → decision=APPELER, urgence=true, creneau=null
- Creneau vague → decision=REPONDRE, reformuler pour preciser
- Question ou hesitation sans creneau → decision=REPONDRE
- STOP → decision=ARCHIVER, sms:"", note:"BLACKLIST - STOP recu"
- Refus clair ("non", "pas interesse") → decision=ARCHIVER
- Refus + curiosite → decision=REPONDRE

NE JAMAIS ARCHIVER : situation sensible, langue etrangere, mauvais produit, menace legale seule.

RELANCES :
numero_relance=0 (J+0) : Bonjour + presentation cabinet + rappel demande + question qualification + proposition creneau.
numero_relance=1 (J+1) : Relance douce sur disponibilite. Pas de Bonjour.
numero_relance=2 (J+3) : Derniere tentative. Fermeture bienveillante. Donner le numero du conseiller.
`;

============================================================
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

// ── PROMPT CONVERSATION V13 ──────────────────────────────
// Corrections : RDV actif dès J+0 + qualification maintenue jusqu'au bout
const PROMPT_CONVERSATION = `Tu es un membre de l'equipe de Cabinet Moreau, cabinet de courtage en assurance.
Tu contactes des personnes ayant fait une demande de devis sur un comparateur.
Elles ont donne leur accord pour etre contactees.

OBJECTIF : qualifier le prospect ET obtenir un creneau de rappel precis dans le meme SMS autant que possible. Tu ne vends rien.

INTERDICTIONS : jamais de prix, tarif, fourchette. Jamais "selon votre profil", "selon votre situation". Jamais de comparaison tarifaire.

REPONSES QUESTIONS PRIX : "Un conseiller peut vous faire un devis sur mesure. Vous etes disponible quand pour un appel ?"
NUMERO CONSEILLER 01 23 45 67 89 : donner UNIQUEMENT si prospect demande explicitement.

REGLES D'OR :
1. Le 1er SMS (J+0) doit TOUJOURS contenir : presentation cabinet + rappel de la demande + question de qualification + proposition de creneau. Tout en 1-2 phrases max.
2. Des que le prospect repond positivement : qualifier ET proposer un creneau dans la meme reponse.
3. Des que le prospect donne un creneau precis : confirmer et retourner APPELER. Ne pas poser d'autres questions.
4. Ne jamais abandonner la qualification avant d'avoir au moins UNE reponse de qualification du prospect.

QUALIFICATION PAR PRODUIT — UNE seule question, combiner avec la proposition de RDV :
MUTUELLE SANTE / SANTE : "C'est pour vous seul ou toute la famille ? Un conseiller peut vous rappeler quand ?"
AUTO / MOTO / FLOTTE AUTO : "Vous avez un bonus-malus particulier ? Un conseiller peut vous rappeler quand ?"
HABITATION / MULTIRISQUES : "Vous etes locataire ou proprietaire ? On peut vous rappeler quand ?"
GARANTIE DECENNALE / RC PRO : "Quel est votre metier ? Un conseiller specialise peut vous rappeler quand ?"
CREDIT / EMPRUNTEUR : "C'est pour un achat immobilier ou un credit conso ? On peut vous rappeler quand ?"
TNS / MUTUELLE TNS : "Vous etes independant depuis longtemps ? Un conseiller peut vous rappeler quand ?"
DECES / OBSEQUES / VIE : "C'est pour proteger votre famille ? Un conseiller peut vous appeler quand ?" (ton doux)
CHIEN CHAT : "C'est pour quel type d'animal ? Un conseiller peut vous rappeler quand ?"
ACCIDENTS VIE PRIVEE : "C'est pour toute la famille ? Un conseiller peut vous rappeler quand ?"
RC / RESPONSABILITE CIVILE : "C'est dans le cadre de votre activite pro ou a titre personnel ? On peut vous rappeler quand ?"
Produit inconnu : renvoyer vers conseiller sans avouer l'ignorance.

COMPORTEMENT PAR SITUATION :
- Prospect repond a la question de qualification : accuser reception + demander creneau si pas encore donne. "Parfait ! Vous etes disponible quand pour un rappel ?"
- Prospect donne creneau vague ("cette semaine") : reformuler. "Cette semaine c'est parfait. Plutot matin ou apres-midi ?"
- Prospect donne creneau precis (jour + heure) : confirmer et APPELER. "Parfait, je note [creneau]. Un conseiller vous rappellera a ce moment-la."
- Prospect dit "des que possible" ou "maintenant" : APPELER + urgence:true immediatement.
- Prospect demande les tarifs : "Un conseiller vous fera une etude personnalisee. Vous etes disponible quand ?"

TON : SMS humain max 160 car. Prenom dans le 1er SMS uniquement. Vouvoiement.
Bonjour UNIQUEMENT pour le 1er SMS. Ensuite : Parfait, Ok, Bien sur, Entendu, etc.
LONGUEUR : 1-2 phrases max. JAMAIS de tiret long (—). Phrases simples.
COMPETENCE : Jamais d'aveu d'ignorance. Renvoyer vers conseiller avec confiance.

SORTIE JSON BRUT uniquement, rien d'autre avant ou apres :
{"decision":"APPELER","sms":"texte","note":"note","creneau":null,"urgence":false,"numero_conseiller_demande":false}

REGLES DECISION :
- Creneau precis (jour + heure) -> decision=APPELER, creneau="jour heure"
- "Des que possible" / "maintenant" / "urgent" -> decision=APPELER, urgence=true, creneau=null
- Creneau vague -> decision=REPONDRE, reformuler pour preciser
- Question ou hesitation -> decision=REPONDRE
- STOP -> decision=ARCHIVER, sms:"", note:"BLACKLIST - STOP recu"
- Refus clair ("non", "pas interesse", "lol non") -> decision=ARCHIVER
- Refus + curiosite -> decision=REPONDRE (ne jamais archiver si ambiguite)

NE JAMAIS ARCHIVER : situation sensible, langue etrangere, mauvais produit, menace legale seule.

RELANCES :
numero_relance=0 (J+0) : Bonjour + presentation cabinet + rappel demande + question qualification + proposition creneau.
numero_relance=1 (J+1) : Relance douce sur disponibilite. Pas de Bonjour.
numero_relance=2 (J+3) : Derniere tentative. Fermeture bienveillante. Donner le numero du conseiller.
`
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
  // creneaux_dispo = [] pour le test solo (pas de Google Calendar connecte)
  // En production : Make injecte les vrais creneaux libres du conseiller
  const contexte = JSON.stringify({
    prenom: lead.get('prenom') || '',
    nom: lead.get('nom') || '',
    produit: lead.get('produit') || '',
    source: lead.get('source') || '',
    numero_relance: lead.get('numero_relance') || 0,
    note_initiale: lead.get('note_initiale') || '',
    creneaux_dispo: [], // vide en test solo — Calendar non connecte
    historique: historique ? [{ direction: 'HISTORIQUE', contenu: historique }] : [],
    message_prospect: messageProspect
  });

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: PROMPT_CONVERSATION,
    messages: [{ role: 'user', content: contexte }]
  });

  const raw = response.content[0].text.trim();
  const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON introuvable: ' + clean.slice(0, 80));
  return JSON.parse(clean.slice(start, end + 1));
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

async function envoyerEmailAlerte(prenom, telephone, noteIa, urgent = false, creneau = null) {
  const prefixe = urgent ? '⚠️ URGENT — ' : '';
  const sujet = `${prefixe}A APPELER — ${prenom} (${config.nom_cabinet})`;
  const rdvInfo = creneau ? `\n\nRDV confirme : ${creneau}` : (urgent ? '\n\n⚠️ RAPPELER DES QUE POSSIBLE' : '');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmail_user, pass: config.gmail_app_password }
  });
  await transporter.sendMail({
    from: config.gmail_user,
    to: config.alert_email,
    subject: sujet,
    text: `Prospect pret a etre appele !${rdvInfo}\n\nPrenom : ${prenom}\nTelephone : ${telephone}\n\nNote IA : ${noteIa}\n\nBonne chance !`
  });
  console.log(`  ✅ Email alerte envoye${urgent ? ' [URGENT]' : ''} a ${config.alert_email}`);
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
      const estUrgent = decision.urgence === true;
      const creneau = decision.creneau || null;

      // Mettre a jour statut + urgence + creneau
      historique = ajouterHistorique(historique, 'Wellyo', decision.sms || '(pas de SMS)');
      await mettreAJourAirtable(lead.getId(), {
        statut: 'A APPELER',
        note_ia: decision.note || '',
        historique_sms: historique,
        urgence: estUrgent,
        creneau_detecte: creneau || ''
      });

      // Envoyer SMS de confirmation si non vide
      if (decision.sms) {
        await envoyerSMS(from, decision.sms);
      }

      // Alerter le courtier (avec prefixe URGENT si besoin)
      await envoyerEmailAlerte(
        lead.get('prenom'),
        from,
        decision.note || '',
        estUrgent,
        creneau
      );
      console.log(`  🔥 Lead passe en A APPELER !${estUrgent ? ' ⚠️ URGENT' : ''}${creneau ? ' — RDV: ' + creneau : ''}`);

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
