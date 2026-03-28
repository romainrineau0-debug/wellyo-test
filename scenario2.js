// ============================================================
// WELLYO TEST SOLO — Scenario 2 : REPONSE_PROSPECT
// Recoit les SMS des prospects via Twilio webhook
// Claude analyse et decide : APPELER / REPONDRE / ARCHIVER
// Prompt V14 — score 8.32/10 sur 15 produits Assurlead
// ============================================================

const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

// Config depuis variables Railway
const config = {
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
  telephone_conseiller: process.env.TELEPHONE_CONSEILLER || '01 23 45 67 89'
};

const claude = new Anthropic({ apiKey: config.claude_api_key });
const airtableBase = new Airtable({ apiKey: config.airtable_token }).base(config.airtable_base_id);
const twilioClient = twilio(config.twilio_account_sid, config.twilio_auth_token);

// ── PROMPT V14 ────────────────────────────────────────────────────────────────
const PROMPT = `Tu es un membre de l'equipe de ${config.nom_cabinet}, cabinet de courtage en assurance.
Tu contactes des personnes ayant fait une demande de devis sur un comparateur.
Elles ont donne leur accord pour etre contactees.

OBJECTIF : qualifier le prospect ET obtenir un creneau de rappel precis. Tu ne vends rien.
INTERDICTIONS : jamais de prix, tarif, fourchette.
REPONSES PRIX : "Les tarifs dependent de votre profil exact, notre conseiller vous fera un devis personnalise. Vous etes disponible quand ?"
NUMERO CONSEILLER ${config.telephone_conseiller} : donner UNIQUEMENT si prospect demande explicitement.

REGLES D OR :
1. Le 1er SMS contient : presentation cabinet + rappel demande + question qualification + proposition creneau.
2. Des que le prospect repond positivement : qualifier ET proposer un creneau.
3. Des que le prospect donne un creneau precis : confirmer et retourner APPELER.
4. Ne jamais ignorer une question du prospect.

QUALIFICATION PAR PRODUIT (UNE seule question) :
MUTUELLE SANTE / SANTE : "C est pour vous seul ou toute la famille ?"
AUTO / MOTO / FLOTTE AUTO : "Vous avez un bonus-malus particulier ?"
HABITATION / MULTIRISQUES : "Vous etes locataire ou proprietaire ?"
GARANTIE DECENNALE / RC PRO : "Quel est votre metier ?"
CREDIT / EMPRUNTEUR : "C est pour un achat immobilier ou un credit conso ?"
TNS / MUTUELLE TNS : "Vous etes independant depuis longtemps ?"
DECES / OBSEQUES / VIE : "C est pour proteger votre famille ?" (ton doux)
CHIEN CHAT : "C est pour quel type d animal ?"
ACCIDENTS VIE PRIVEE : "Vous souhaitez une couverture pour toute la famille ?"
RC / RESPONSABILITE CIVILE : "C est dans le cadre de votre activite pro ou a titre personnel ?"
Produit inconnu : renvoyer vers conseiller sans avouer l ignorance.

TON : SMS humain max 160 car. Prenom dans le 1er SMS uniquement. Vouvoiement.
Bonjour UNIQUEMENT pour le 1er SMS. Ensuite : Parfait, Ok, Bien sur, Entendu.
LONGUEUR : 1-2 phrases max. JAMAIS de tiret long.

SORTIE JSON BRUT uniquement, rien d autre :
{"decision":"APPELER","sms":"texte","note":"note","creneau":null,"urgence":false,"numero_conseiller_demande":false}

Creneau precis -> APPELER. "Des que possible" -> APPELER urgence:true.
Creneau vague -> REPONDRE reformuler. STOP -> ARCHIVER sms:"". Refus clair -> ARCHIVER.`;

// ── FONCTIONS ─────────────────────────────────────────────────────────────────

function parseJSON(raw) {
  const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('JSON introuvable: ' + clean.slice(0, 80));
  return JSON.parse(clean.slice(s, e + 1));
}

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
    numero_relance: lead.get('numero_relance') || 0,
    note_initiale: lead.get('note_initiale') || '',
    creneaux_dispo: [],
    historique: historique ? [{ direction: 'HISTORIQUE', contenu: historique }] : [],
    message_prospect: messageProspect
  });

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: PROMPT,
    messages: [{ role: 'user', content: contexte }]
  });

  return parseJSON(response.content[0].text.trim());
}

async function envoyerSMS(telephone, message) {
  await twilioClient.messages.create({
    body: message,
    from: config.twilio_from_number,
    to: telephone
  });
}

async function envoyerEmailAlerte(prenom, telephone, noteIa, urgent, creneau) {
  const prefixe = urgent ? 'URGENT - ' : '';
  const rdvInfo = creneau ? `\n\nRDV confirme : ${creneau}` : (urgent ? '\n\nRAPPELER DES QUE POSSIBLE' : '');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmail_user, pass: config.gmail_app_password }
  });
  await transporter.sendMail({
    from: config.gmail_user,
    to: config.alert_email,
    subject: `${prefixe}A APPELER - ${prenom} (${config.nom_cabinet})`,
    text: `Prospect pret a etre appele !${rdvInfo}\n\nPrenom : ${prenom}\nTelephone : ${telephone}\n\nNote IA : ${noteIa}\n\nBonne chance !`
  });
  console.log(`  Email alerte envoye${urgent ? ' [URGENT]' : ''}`);
}

function ajouterHistorique(historiqueActuel, role, message) {
  const horodatage = new Date().toLocaleString('fr-FR');
  const ligne = `[${role}] ${horodatage}\n${message}`;
  return historiqueActuel ? historiqueActuel + '\n\n' + ligne : ligne;
}

// ── TRAITEMENT SMS ENTRANT ────────────────────────────────────────────────────

async function traiterSMSEntrant(from, body) {
  console.log(`\nSMS recu de ${from} : "${body}"`);

  try {
    const lead = await trouverLead(from);
    if (!lead) {
      console.log('  Aucun lead EN COURS trouve pour ce numero');
      return;
    }
    console.log(`  Lead : ${lead.get('prenom')} ${lead.get('nom')}`);

    let historique = lead.get('historique_sms') || '';
    historique = ajouterHistorique(historique, 'Prospect', body);
    await mettreAJourAirtable(lead.getId(), { historique_sms: historique });

    console.log('  Appel Claude...');
    const decision = await analyserReponse(lead, body);
    console.log(`  Decision : ${decision.decision}`);

    if (decision.decision === 'APPELER') {
      const estUrgent = decision.urgence === true;
      const creneau = decision.creneau || null;

      historique = ajouterHistorique(historique, 'Wellyo', decision.sms || '');
      // Mise à jour principale
      await mettreAJourAirtable(lead.getId(), {
        statut: 'A APPELER',
        note_ia: decision.note || '',
        historique_sms: historique
      });
      // Mise à jour champs optionnels
      try {
        await mettreAJourAirtable(lead.getId(), {
          urgence: estUrgent,
          creneau_detecte: creneau || ''
        });
      } catch(e) {
        console.log('  Champs urgence/creneau non mis a jour:', e.message);
      }

      if (decision.sms) await envoyerSMS(from, decision.sms);

      await envoyerEmailAlerte(
        lead.get('prenom'), from,
        decision.note || '', estUrgent, creneau
      );
      console.log(`  Lead passe en A APPELER${estUrgent ? ' URGENT' : ''}${creneau ? ' - RDV: ' + creneau : ''}`);

    } else if (decision.decision === 'REPONDRE') {
      if (decision.sms) {
        await envoyerSMS(from, decision.sms);
        historique = ajouterHistorique(historique, 'Wellyo', decision.sms);
      }
      await mettreAJourAirtable(lead.getId(), {
        note_ia: decision.note || '',
        historique_sms: historique
      });
      console.log('  Reponse envoyee, lead reste EN COURS');

    } else if (decision.decision === 'ARCHIVER') {
      const estStop = body.toUpperCase().includes('STOP');
      if (!estStop && decision.sms) {
        await envoyerSMS(from, decision.sms);
        historique = ajouterHistorique(historique, 'Wellyo', decision.sms);
      }
      await mettreAJourAirtable(lead.getId(), {
        statut: 'ARCHIVE',
        note_ia: decision.note || '',
        historique_sms: historique
      });
      console.log(`  Lead archive (${estStop ? 'STOP' : 'refus'})`);
    }

  } catch(err) {
    console.log('  Erreur:', err.message);
  }
}

// ── SERVEUR WEBHOOK ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      // Repondre immediatement a Twilio pour eviter le timeout
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response></Response>');
      // Traiter le SMS en arriere-plan
      try {
        const params = new URLSearchParams(body);
        const from = params.get('From');
        const message = params.get('Body');
        console.log('Webhook recu - From:', from, 'Body:', message ? message.slice(0,30) : 'vide');
        if (from && message) {
          traiterSMSEntrant(from, message).catch(err => {
            console.log('Erreur traitement SMS:', err.message);
          });
        }
      } catch(err) {
        console.log('Erreur parsing webhook:', err.message);
      }
    });
  } else {
    res.writeHead(200);
    res.end('Wellyo Scenario 2 - OK');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Wellyo Test Solo - Scenario 2 demarre');
  console.log(`Serveur webhook actif sur le port ${PORT}`);
  console.log('En attente de SMS entrants...');
});

// Empecher le process de s arreter
process.on('uncaughtException', (err) => {
  console.log('Erreur non geree:', err.message);
});
