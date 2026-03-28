// ============================================================
// WELLYO TEST SOLO — Scenario 2 : REPONSE_PROSPECT
// Recoit les SMS des prospects via Twilio webhook
// Claude analyse et decide : APPELER / REPONDRE / ARCHIVER
// Prompt V14 — corrige le 28/03/2026
// ============================================================

const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

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
REPONSES PRIX : "Les tarifs dependent de votre profil exact, notre conseiller vous fera un devis personnalise. Quand seriez-vous disponible ?"
NUMERO CONSEILLER ${config.telephone_conseiller} : donner UNIQUEMENT si prospect demande explicitement.

INTERDICTIONS LANGUE : jamais "dispo" -> utiliser "disponible". Jamais "Vous etes disponible quand ?" -> utiliser "Quand seriez-vous disponible ?" ou "Quand etes-vous disponible ?". Phrases correctes en francais uniquement.
INTERDICTIONS TECHNIQUES : jamais affirmer ce qu'on peut ou ne peut pas faire (ex: "Nous pouvons vous assurer", "Nous couvrons"). Pour toute question technique, medicale ou reglementaire : "Notre conseiller pourra vous repondre precisement sur ce point, quand seriez-vous disponible ?"

REGLES D OR :
1. Le 1er SMS contient : presentation cabinet + rappel demande + question qualification + proposition creneau.
2. Des que le prospect repond positivement : qualifier ET proposer un creneau.
3. Des que le prospect donne un creneau precis (jour + heure) : confirmer et retourner APPELER.
4. Ne jamais ignorer une question du prospect.
5. Utiliser le champ date_du_jour du contexte pour resoudre "demain", "ce soir", "lundi". Ex: si date_du_jour est dimanche 29 mars, "demain" = lundi 30 mars. Toujours confirmer avec le vrai jour et la vraie date.
6. Pour toute question technique ou reglementaire : renvoyer vers le conseiller sans affirmer.

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

REGLES CRENEAU :
- Creneau precis (jour + heure exacte) -> APPELER immediatement.
- Jour sans heure ("mercredi apres-midi", "demain") -> REPONDRE demander heure exacte. Ex: "Lundi c'est parfait, vous preferez 9h, 10h ou 11h ?"
- Creneau vague ("cette semaine") -> REPONDRE demander jour ET heure. Ex: "Jeudi ou vendredi ? Et vers quelle heure ?"
- JAMAIS confirmer une plage horaire ("entre 14h et 17h") -> toujours une heure precise.
- A la confirmation : "Parfait, je note [jour date heure]. Notre conseiller vous rappellera a ce moment-la." Le mot "rappellera" suffit, ne JAMAIS ajouter "par telephone".
- "Des que possible" / "maintenant" -> APPELER urgence:true immediatement.
- STOP -> ARCHIVER sms:"". Refus clair -> ARCHIVER.

TON : SMS humain max 160 car. Prenom dans le 1er SMS uniquement. Vouvoiement.
Bonjour UNIQUEMENT pour le 1er SMS. Ensuite : Parfait, Ok, Bien sur, Entendu.
LONGUEUR : 1-2 phrases max. JAMAIS de tiret long.
COMPETENCE : Jamais d'aveu d'ignorance. Renvoyer vers conseiller avec confiance.

SORTIE JSON BRUT uniquement, rien d'autre :
{"decision":"APPELER","sms":"texte","note":"note","creneau":null,"urgence":false,"numero_conseiller_demande":false}
IMPORTANT : le champ "creneau" doit etre en texte lisible francais (ex: "lundi 30 mars a 10h") JAMAIS en format ISO ou timestamp.`;

// ── FONCTIONS ─────────────────────────────────────────────────────────────────

function parseJSON(raw) {
  const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('JSON introuvable: ' + clean.slice(0, 80));
  return JSON.parse(clean.slice(s, e + 1));
}

function ajouterHistorique(historiqueActuel, role, message) {
  const horodatage = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const ligne = `[${role}] ${horodatage}\n${message}`;
  return historiqueActuel ? historiqueActuel + '\n\n' + ligne : ligne;
}

async function trouverLeadParStatut(telephone, statut) {
  return new Promise((resolve, reject) => {
    airtableBase(config.airtable_table).select({
      filterByFormula: `AND({telephone} = '${telephone}', {statut} = '${statut}')`
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

async function sauvegarderHistorique(lead, historique) {
  try {
    await mettreAJourAirtable(lead.getId(), { historique_sms: historique });
  } catch(e) {
    console.log('  Erreur sauvegarde historique:', e.message);
  }
}

async function envoyerSMS(telephone, message) {
  await twilioClient.messages.create({
    body: message,
    from: config.twilio_from_number,
    to: telephone
  });
}

async function analyserReponse(lead, messageProspect) {
  const maintenant = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Paris'
  });
  const heureFR = new Date().toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'
  });

  const contexte = JSON.stringify({
    date_du_jour: maintenant,
    heure_actuelle: heureFR,
    prenom: lead.get('prenom') || '',
    nom: lead.get('nom') || '',
    produit: lead.get('produit') || '',
    source: lead.get('source') || '',
    numero_relance: lead.get('numero_relance') || 0,
    note_initiale: lead.get('note_initiale') || '',
    creneaux_dispo: [],
    historique: (lead.get('historique_sms') || '').split('\n\n').slice(-6).join('\n\n'),
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

async function envoyerEmailAlerte(prenom, telephone, noteIa, urgent, creneau) {
  try {
    const prefixe = urgent ? 'URGENT - ' : '';
    const rdvInfo = creneau ? `\n\nRDV confirme : ${creneau}` : (urgent ? '\n\nRAPPELER DES QUE POSSIBLE' : '');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.gmail_user, pass: config.gmail_app_password },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000
    });
    await transporter.sendMail({
      from: config.gmail_user,
      to: config.alert_email,
      subject: `${prefixe}A APPELER - ${prenom} (${config.nom_cabinet})`,
      text: `Prospect pret a etre appele !${rdvInfo}\n\nPrenom : ${prenom}\nTelephone : ${telephone}\n\nNote IA : ${noteIa}`
    });
    console.log('  Email alerte envoye');
  } catch(e) {
    console.log('  Email alerte non envoye:', e.message);
  }
}

// ── MESSAGE DE CLOTURE — HARDCODE, JAMAIS CLAUDE ─────────────────────────────
function formaterCreneau(creneau) {
  if (!creneau) return null;
  // Si format ISO (2026-03-29T10:00:00), convertir en texte lisible
  if (creneau.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)) {
    const d = new Date(creneau);
    return d.toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Paris'
    }).replace(' à 00:00', '');
  }
  return creneau;
}

function messageCloture(prenom, creneau, urgent) {
  if (urgent) {
    return `Bien recu ${prenom} ! Un conseiller vous rappelle dans les plus brefs delais.`;
  }
  const creneauFormate = formaterCreneau(creneau);
  if (creneauFormate) {
    return `C'est bien note ${prenom}. Notre conseiller vous rappellera le ${creneauFormate}. A bientot !`;
  }
  return `C'est bien note ${prenom}. Notre conseiller vous rappellera prochainement. A bientot !`;
}

// ── TRAITEMENT SMS ENTRANT ────────────────────────────────────────────────────

async function traiterSMSEntrant(from, body) {
  console.log(`\nSMS recu de ${from} : "${body.slice(0, 50)}"`);

  const isStop = /^stop[\s\.,!?]*/i.test(body.trim());

  try {
    // ── CAS 1 : lead EN COURS ──
    const lead = await trouverLeadParStatut(from, 'EN COURS');
    if (lead) {
      console.log(`  Lead EN COURS : ${lead.get('prenom')} ${lead.get('nom')}`);

      // Sauvegarder message entrant immediatement
      let historique = lead.get('historique_sms') || '';
      historique = ajouterHistorique(historique, 'Prospect', body);
      await sauvegarderHistorique(lead, historique);

      if (isStop) {
        await mettreAJourAirtable(lead.getId(), { statut: 'ARCHIVE', historique_sms: historique, note_ia: 'BLACKLIST - STOP recu' });
        console.log('  STOP -> ARCHIVE');
        return;
      }

      // Appeler Claude
      console.log('  Appel Claude...');
      const decision = await analyserReponse(lead, body);
      console.log(`  Decision Claude : ${decision.decision}`);

      // Recharger le lead pour avoir le statut le plus recent (eviter race condition)
      const leadFrais = await trouverLeadParStatut(from, 'EN COURS');
      if (!leadFrais) {
        console.log('  Lead passe en A APPELER pendant analyse Claude — message de cloture envoye');
        const leadAppeler = await trouverLeadParStatut(from, 'A APPELER');
        if (leadAppeler) {
          const msg = messageCloture(leadAppeler.get('prenom'), leadAppeler.get('creneau_detecte'), false);
          await envoyerSMS(from, msg);
          let hist = leadAppeler.get('historique_sms') || '';
          hist = ajouterHistorique(hist, 'Wellyo', msg);
          await sauvegarderHistorique(leadAppeler, hist);
        }
        return;
      }

      if (decision.decision === 'APPELER') {
        const estUrgent = decision.urgence === true;
        const creneau = decision.creneau || null;

        // Generer message de confirmation
        const smsFinal = decision.sms || messageCloture(lead.get('prenom'), creneau, estUrgent);

        // Sauvegarder dans historique + mettre a jour statut en une seule operation
        historique = ajouterHistorique(historique, 'Wellyo', smsFinal);
        await mettreAJourAirtable(lead.getId(), {
          statut: 'A APPELER',
          note_ia: decision.note || '',
          historique_sms: historique
        });
        try { await mettreAJourAirtable(lead.getId(), { creneau_detecte: creneau || '' }); } catch(e) {}
        try { await mettreAJourAirtable(lead.getId(), { urgence: estUrgent }); } catch(e) { console.log('  urgence:', e.message); }

        await envoyerSMS(from, smsFinal);
        await envoyerEmailAlerte(lead.get('prenom'), from, decision.note || '', estUrgent, creneau);
        console.log(`  -> A APPELER${estUrgent ? ' URGENT' : ''}${creneau ? ' | RDV: ' + creneau : ''}`);

      } else if (decision.decision === 'REPONDRE') {
        if (decision.sms) {
          historique = ajouterHistorique(historique, 'Wellyo', decision.sms);
          await sauvegarderHistorique(leadFrais, historique);
          await envoyerSMS(from, decision.sms);
        }
        console.log('  -> REPONDRE, lead reste EN COURS');

      } else if (decision.decision === 'ARCHIVER') {
        if (decision.sms) {
          historique = ajouterHistorique(historique, 'Wellyo', decision.sms);
          await envoyerSMS(from, decision.sms);
        }
        await mettreAJourAirtable(leadFrais.getId(), {
          statut: 'ARCHIVE',
          note_ia: decision.note || '',
          historique_sms: historique
        });
        console.log('  -> ARCHIVE (refus)');
      }
      return;
    }

    // ── CAS 2 : lead A APPELER — message de cloture hardcode ──
    const leadAppeler = await trouverLeadParStatut(from, 'A APPELER');
    if (leadAppeler) {
      console.log(`  Lead A APPELER : ${leadAppeler.get('prenom')}`);

      if (isStop) {
        let hist = leadAppeler.get('historique_sms') || '';
        hist = ajouterHistorique(hist, 'Prospect', body);
        await mettreAJourAirtable(leadAppeler.getId(), { statut: 'ARCHIVE', historique_sms: hist, note_ia: 'BLACKLIST - STOP recu apres qualification' });
        console.log('  STOP -> ARCHIVE');
        return;
      }

      // Message hardcode — JAMAIS Claude ici
      const creneau = leadAppeler.get('creneau_detecte') || '';
      const prenom = leadAppeler.get('prenom') || '';
      const urgent = leadAppeler.get('urgence') || false;
      const msg = messageCloture(prenom, creneau, urgent);

      // Sauvegarder le message du prospect ET la reponse dans historique
      let hist = leadAppeler.get('historique_sms') || '';
      hist = ajouterHistorique(hist, 'Prospect', body);
      hist = ajouterHistorique(hist, 'Wellyo', msg);
      await sauvegarderHistorique(leadAppeler, hist);
      await envoyerSMS(from, msg);
      console.log('  Message de cloture envoye (hardcode)');
      return;
    }

    console.log('  Aucun lead trouve pour ce numero');

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
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response></Response>');
      try {
        const params = new URLSearchParams(body);
        const from = params.get('From');
        const message = params.get('Body');
        console.log('Webhook recu - From:', from, 'Body:', message ? message.slice(0, 40) : 'vide');
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

process.on('uncaughtException', (err) => {
  console.log('Erreur non geree:', err.message);
});
