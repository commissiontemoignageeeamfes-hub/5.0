/**
 * send-reminders.js
 * ────────────────────────────────────────────────────────────
 * Exécute EXACTEMENT la même logique que le rattrapage client
 * (checkRappelHebdoContact / checkRappelVisiteMensuelle dans
 * index.html), mais côté serveur, via une tâche planifiée
 * gratuite (GitHub Actions). Fonctionne même si personne n'ouvre
 * l'application — c'est ce qui rend les rappels "fiables".
 *
 * ⚠️ VALIDATION 100% MANUELLE, PAR ÉVANGÉLISTE, PAR CANAL :
 * Pour chaque évangéliste actif, ce script dépose UNE entrée dans
 * `communications_queue` (statut "attente") — que ce soit pour le
 * rappel hebdo, le rappel visite mensuelle, ou une sortie collective.
 * RIEN ne part automatiquement : le/la responsable doit cliquer,
 * séparément :
 *   - "Envoyer l'email"           -> emailEnvoye = true
 *   - "Envoyer la notification"   -> notifEnvoyee = true (in-app, instantané)
 *                                     + pushDemande = true (device, voir plus bas)
 * L'entrée ne passe à l'historique que lorsque les DEUX ont été faits.
 * (Depuis la mise à jour communications, la responsable peut aussi
 * sélectionner plusieurs entrées et les envoyer en groupe depuis
 * l'app — mais chaque envoi reste un geste manuel de sa part.)
 *
 * Note sur la notification "device" (bannière téléphone) :
 * Le navigateur ne peut pas signer/envoyer un vrai push tout seul (il faut
 * la clé privée VAPID, qui ne vit que côté serveur pour rester secrète).
 * Donc quand le/la responsable clique "Envoyer la notification" dans
 * l'app, ça écrit pushDemande:true sur le document. C'est CE script,
 * à son prochain passage (planifié toutes les X minutes/heures), qui va
 * réellement livrer la bannière et marquer pushEnvoye:true. Court délai,
 * normal et inévitable avec cette architecture 100% gratuite.
 *
 * Coûts : 0€.
 *  - GitHub Actions : gratuit pour ce volume (quelques secondes/jour).
 *  - Firestore       : quelques lectures/écritures par jour, largement
 *                      dans le quota gratuit "Spark".
 *  - EmailJS         : réutilise le même compte/template que l'app
 *                      (plan gratuit 200 emails/mois), déclenché
 *                      uniquement depuis le navigateur du/de la
 *                      responsable au moment du clic "Envoyer l'email".
 *
 * Prérequis (secrets GitHub à créer, voir README.md) :
 *   FIREBASE_SERVICE_ACCOUNT_JSON  -> clé de compte de service Firebase (JSON, en une ligne / base64)
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY -> pour les notifications push
 *
 * NB : EMAILJS_PRIVATE_KEY n'est plus utilisée par ce script — l'envoi
 * d'email se fait désormais depuis le navigateur du/de la responsable.
 *
 * ── FIABILITÉ (mise à jour communications) ─────────────────
 * Avant, ce script ne déclenchait le rappel hebdo QUE le dimanche, et
 * le rappel visite mensuelle QUE le jour exact J-7 fin de mois — sans
 * rattrapage si le run GitHub Actions de ce jour-là échouait ou était
 * sauté. Côté client, un rattrapage existait déjà (lundi pour l'hebdo,
 * fenêtre de 3 jours pour la visite). Le serveur applique maintenant
 * les mêmes fenêtres de rattrapage, pour ne plus dépendre d'un unique
 * passage cron qui pourrait manquer sa fenêtre.
 *
 * ── CORRECTIF (index Firestore) ────────────────────────────
 * La requête de livraison des push demandés (runPushDemandes) filtrait
 * auparavant sur DEUX champs (pushDemande == true ET pushEnvoye != true),
 * ce qui exige un index composite Firestore. Sans cet index, la requête
 * plantait avec "FAILED_PRECONDITION: The query requires an index",
 * ce qui faisait échouer tout le script (❌ sur GitHub Actions). On
 * filtre désormais pushEnvoye directement en JavaScript après une
 * requête simple à un seul champ, qui ne nécessite aucun index.
 */

const admin = require('firebase-admin');
const webpush = require('web-push');

/* ── 1. Initialisation Firebase Admin ─────────────────────── */
const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error('❌ Variable FIREBASE_SERVICE_ACCOUNT_JSON manquante.');
  process.exit(1);
}
const serviceAccount = JSON.parse(
  raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

/* ── 1bis. Config Web Push (VAPID — gratuit, aucun service tiers payant) ── */
// ⚠️ Cette valeur de secours DOIT être IDENTIQUE à la constante VAPID_PUBLIC_KEY
// codée en dur dans index.html (celle utilisée par pushManager.subscribe côté
// évangéliste). Si les deux clés diffèrent, chaque notification part signée
// avec la mauvaise paire de clés : le serveur croit l'avoir livrée (aucune
// erreur bloquante), mais rien n'arrive jamais sur le téléphone. Le vrai
// réglage propre reste de définir le secret GitHub VAPID_PUBLIC_KEY (même
// valeur que dans index.html) — cette valeur en dur n'est qu'un filet de
// sécurité pour ne jamais retomber sur une clé différente par erreur.
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BLDoHy4WDsUo3HNLq8fpFg5y9GafTqp64pHZ_NN62wbECKKz7o0-RWhlUOroI0LnT-UWDfkAo3fJvyrLbZmwliM';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:commission.temoignage.fes@example.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('⚠️ VAPID_PRIVATE_KEY absente — notifications push (téléphone) ignorées.');
}

async function sendPush(evId, title, body) {
  if (!VAPID_PRIVATE_KEY) return false;
  const doc = await db.collection('push_subscriptions').doc(evId).get();
  if (!doc.exists) return false; // n'a pas activé les notifications sur cet appareil
  const sub = doc.data().subscription;
  if (!sub) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      // Abonnement expiré/invalide côté navigateur : on le supprime, l'évangéliste
      // devra réactiver les notifications (comportement normal et attendu).
      await db.collection('push_subscriptions').doc(evId).delete().catch(() => {});
      console.warn(`⚠️ Abonnement expiré pour ${evId} — supprimé, réactivation nécessaire.`);
    } else if (e.statusCode === 401 || e.statusCode === 403) {
      // Signature VAPID refusée : la clé publique côté client ne correspond PAS
      // à la clé privée utilisée ici pour signer. Ce n'est PAS un problème
      // d'abonnement individuel — TOUS les push vont échouer de la même façon
      // tant que VAPID_PUBLIC_KEY (secret GitHub) et la constante dans index.html
      // ne sont pas rigoureusement identiques. On ne supprime pas l'abonnement
      // (il n'est pas en cause) ; il faut corriger la clé et relancer.
      console.error(`❌ ERREUR VAPID (${e.statusCode}) pour ${evId} : clé publique/privée non appariées. Vérifiez que le secret GitHub VAPID_PUBLIC_KEY est identique à la constante VAPID_PUBLIC_KEY dans index.html.`);
    } else {
      console.warn(`⚠️ Push non délivré pour ${evId} :`, e.statusCode || e.message);
    }
    return false;
  }
}

/* ── Dépôt / mise à jour dans la file "Communications" ─────
   (jamais d'envoi direct d'email ou de notif ici — juste le dépôt) */
async function queueCommunication(docId, data) {
  await db.collection('communications_queue').doc(docId).set({
    ...data,
    statut:       'attente',
    emailEnvoye:  false,
    notifEnvoyee: false,
    pushDemande:  false,
    pushEnvoye:   false,
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    source:       'server',
  }, { merge: true });
}

const versets = [
  { txt: 'Allez, faites de toutes les nations des disciples...', ref: 'Matthieu 28 : 19' },
  { txt: 'Vous serez mes témoins jusqu\'aux extrémités de la terre.', ref: 'Actes 1 : 8' },
];

/* ── Helpers de date (identiques au client) ───────────────── */
function isSemaine1(d) { return d.getDate() <= 7; }
function isDerniereSemaine(d) {
  const dernierJour = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() > dernierJour - 7;
}
function cleHebdo(d) {
  const tag = isSemaine1(d) ? 'S1' : (isDerniereSemaine(d) ? 'SF' : null);
  return tag ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${tag}` : null;
}
function cleMois(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* Récap d'activité de la semaine écoulée (visites + appels/messages) */
async function getRecapSemaine(evId, now) {
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);
  const snap = await db.collection('activites')
    .where('evangelisteId', '==', evId)
    .where('date', '>=', weekAgoStr)
    .get();
  const acts = snap.docs.map(d => d.data());
  return {
    nbVisites:   acts.filter(a => a.type === 'visite').length,
    nbAppelsMsg: acts.filter(a => a.type === 'appel' || a.type === 'message').length,
  };
}

/* ── 4. Rappel hebdo : contacter ses fiches d'ici lundi ─────
   Génère une entrée POUR CHAQUE évangéliste actif (même sans
   fiche assignée), le dimanche — avec rattrapage le lundi si le
   run du dimanche a été manqué (même fenêtre que côté client),
   pour envoi manuel par la responsable. */
async function runRappelHebdo(now) {
  const jour = now.getDay(); // 0 = dimanche, 1 = lundi (rattrapage)
  let refDate;
  if (jour === 0) refDate = now;
  else if (jour === 1) refDate = new Date(now.getTime() - 86400000);
  else return;

  const cle = cleHebdo(refDate);
  if (!cle) return; // ni 1ère semaine ni dernière semaine du mois

  const [evsSnap, fichesSnap] = await Promise.all([
    db.collection('evangelistes').where('actif', '!=', false).get(),
    db.collection('fiches').get(),
  ]);
  const fiches = fichesSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => !f.deleted);

  for (const evDoc of evsSnap.docs) {
    const ev = { id: evDoc.id, ...evDoc.data() };
    const docId = `${ev.id}_${cle}`;
    const ref = db.collection('rappels_hebdo').doc(docId);
    const snap = await ref.get();
    if (snap.exists) continue; // déjà généré (par le client ou un run précédent)
    await ref.set({ evId: ev.id, cle, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'server' });

    const mesFiches = fiches.filter(f => f.evangelisteId === ev.id);
    const v = versets[0];
    const { nbVisites, nbAppelsMsg } = await getRecapSemaine(ev.id, now);

    const contenu = mesFiches.length
      ? `Bonjour ${ev.nom},\n\nBelle semaine à vous ! Voici votre point hebdomadaire.\n\nFiches à contacter d'ici lundi (${mesFiches.length}) :\n${mesFiches.map(f => `- ${f.nom} ${f.prenom}`).join('\n')}\n\nCette semaine : ${nbVisites} visite(s) effectuée(s), ${nbAppelsMsg} appel(s)/message(s) envoyé(s). Merci pour votre engagement fidèle !\n\n"${v.txt}" (${v.ref})\n\nFraternellement,\nCommission Témoignage — EEAM Fès`
      : `Bonjour ${ev.nom},\n\nBelle semaine à vous ! Petit rappel : pensez à prendre des nouvelles des personnes que vous suivez d'ici lundi.\n\n"${v.txt}" (${v.ref})\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

    await queueCommunication(`${ev.id}_${cle}_hebdo`, {
      type: 'hebdo', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null, cle, contenu,
      nbFiches: mesFiches.length,
    });
    console.log(`✔ Rappel hebdo déposé pour ${ev.nom} (à valider par la responsable)`);
  }
}

/* ── 5. Rappel mensuel : visite accompagnée ─────────────────
   Génère une entrée pour chaque évangéliste ayant des fiches, à
   J-7 de la fin du mois — avec une fenêtre de rattrapage de 3
   jours (même fenêtre que côté client) si le run du jour cible a
   été manqué, pour validation manuelle. */
async function runRappelVisiteMensuelle(now) {
  const dernierJourMois = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const jourCible = dernierJourMois - 7;
  if (now.getDate() < jourCible || now.getDate() > jourCible + 2) return; // fenêtre de rattrapage : 3 jours
  const cle = cleMois(now);

  const [evsSnap, fichesSnap] = await Promise.all([
    db.collection('evangelistes').where('actif', '!=', false).get(),
    db.collection('fiches').get(),
  ]);
  const evs = evsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const fiches = fichesSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => !f.deleted);

  for (const ev of evs) {
    const docId = `${ev.id}_${cle}`;
    const ref = db.collection('rappels_visite_mois').doc(docId);
    const snap = await ref.get();
    if (snap.exists) continue;
    await ref.set({ evId: ev.id, cle, createdAt: admin.firestore.FieldValue.serverTimestamp(), source: 'server' });

    const mesFiches = fiches.filter(f => f.evangelisteId === ev.id);
    if (!mesFiches.length) continue; // rien à programmer pour cet évangéliste ce mois-ci

    const collegues = evs.filter(e => e.disponible && e.id !== ev.id && e.equipe === ev.equipe);
    const nomsCollegues = collegues.length
      ? collegues.map(e => e.nom).join(', ')
      : 'aucun signalé pour l\'instant — voir avec la responsable de zone';

    const v = versets[1];
    const contenu = `Bonjour ${ev.nom},\n\nNouveau mois, nouvelle occasion de marcher aux côtés de ceux que vous suivez !\n\nPensez à programmer une visite accompagnée ce mois-ci pour vos ${mesFiches.length} fiche(s) :\n${mesFiches.map(f => `- ${f.nom} ${f.prenom}`).join('\n')}\n\nAccompagnateur(s) suggéré(s) : ${nomsCollegues}\n\n"${v.txt}" (${v.ref})\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

    await queueCommunication(`${ev.id}_${cle}_visite`, {
      type: 'visite_mois', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null, cle, contenu,
      nbFiches: mesFiches.length,
    });
    console.log(`✔ Rappel visite mensuelle déposé pour ${ev.nom} (à valider par la responsable)`);
  }
}

/* ── 6. Sorties collectives programmées par la responsable ──
   Dès qu'une sortie est publiée (notifie:false), une invitation
   est déposée pour CHAQUE évangéliste actif — email et notif
   restent entièrement manuels, comme les autres rappels.       */
async function runSortiesCollectives() {
  const snap = await db.collection('sorties_collectives').where('notifie', '==', false).get();
  if (snap.empty) return;

  const evsSnap = await db.collection('evangelistes').where('actif', '!=', false).get();
  let evs = evsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const doc of snap.docs) {
    const s = doc.data();
    const cibles = Array.isArray(s.destinataires) && s.destinataires.length
      ? evs.filter(e => s.destinataires.includes(e.id))
      : evs; // pas de sélection enregistrée -> comportement historique (tous les actifs)
    const dateLabel = new Date(s.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    for (const ev of cibles) {
      const contenu = `Bonjour ${ev.nom},\n\nUne nouvelle sortie d'évangélisation vous attend ! Venez nombreux, votre présence compte pour l'équipe.\n\nLieu : ${s.lieu}\nDate : ${dateLabel}\n${s.description ? `Détail : ${s.description}\n` : ''}\nMerci d'indiquer votre présence dans l'app (Je viens / Je ne peux pas) dès que possible.\n\n"${versets[1].txt}" (${versets[1].ref})\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

      await queueCommunication(`${doc.id}_${ev.id}_sortie`, {
        type: 'sortie', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null,
        cle: doc.id, contenu,
      });
    }
    await doc.ref.update({ notifie: true, notifieAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`✔ Sortie collective "${s.lieu}" — invitations déposées pour ${cibles.length} évangéliste(s) (à valider)`);
  }
}

/* ── 6bis. Rappel 48h avant une action ou visite prévue ─────
   Remplace l'ancien mécanisme client peu fiable (setTimeout qui ne
   fonctionnait que si le navigateur restait ouvert). Ici, détection
   fiable chaque jour via le cron : toute fiche dont la prochaine
   action (nextActionDate) ou la prochaine visite (prochaineVisite)
   tombe dans 2 jours reçoit un rappel nominatif, chaleureux, avec
   un encouragement et une bénédiction. ── */
async function runRappelActionPrevue(now) {
  const dans2jours = new Date(now.getTime() + 2 * 86400000).toISOString().split('T')[0];

  const fichesSnap = await db.collection('fiches').get();
  const fiches = fichesSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(f => !f.deleted && (f.nextActionDate === dans2jours || f.prochaineVisite === dans2jours));
  if (!fiches.length) return;

  const evsSnap = await db.collection('evangelistes').get();
  const evs = evsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const f of fiches) {
    if (!f.evangelisteId) continue;
    const ev = evs.find(e => e.id === f.evangelisteId);
    if (!ev) continue;

    const dateCible = f.nextActionDate === dans2jours ? f.nextActionDate : f.prochaineVisite;
    const docId = `${f.id}_${dateCible}_action`;
    const ref = db.collection('rappels_action_prevue').doc(docId);
    const snap2 = await ref.get();
    if (snap2.exists) continue;
    await ref.set({ ficheId: f.id, dateCible, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    const nomFiche = `${f.nom || ''} ${f.prenom || ''}`.trim();
    const actionTexte = f.nextActionDate === dans2jours && f.nextAction ? f.nextAction : 'Visite prévue';
    const dateLabel = new Date(dateCible).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const v = versets[Math.floor(Math.random() * versets.length)];

    const contenu = `Bonjour ${ev.nom},\n\nUn rendez-vous approche : "${actionTexte}" avec ${nomFiche}, ${dateLabel} (dans 2 jours).\n\nPrenez un moment pour prier pour cette rencontre et pour ${nomFiche}. Que le Seigneur prépare les coeurs et vous donne les mots justes !\n\n"${v.txt}" (${v.ref})\n\nQue Dieu vous bénisse et vous accompagne.\n\nFraternellement,\nCommission Témoignage — EEAM Fès`;

    await queueCommunication(`${f.id}_${dateCible}_action_comm`, {
      type: 'action_prevue', evId: ev.id, evNom: ev.nom, evEmail: ev.email || null,
      cle: dateCible, contenu, ficheNom: nomFiche,
    });
    console.log(`✔ Rappel action prévue déposé pour ${ev.nom} — ${nomFiche} (${dateLabel})`);
  }
}

/* ── 7. Livraison effective des notifications "device" demandées ──
   Quand le/la responsable clique "Envoyer la notification" dans
   l'app, ça pose pushDemande:true. Ce script livre la vraie bannière
   téléphone à son prochain passage (la clé privée VAPID ne peut
   vivre que côté serveur).
   CORRECTIF : requête simplifiée à un seul champ (pushDemande==true)
   pour ne PAS nécessiter d'index composite Firestore — le filtre sur
   pushEnvoye se fait ensuite en mémoire, en JavaScript. ── */
async function runPushDemandes(now) {
  const snap = await db.collection('communications_queue')
    .where('pushDemande', '==', true)
    .get();
  if (snap.empty) return;

  const aTraiter = snap.docs.filter(doc => doc.data().pushEnvoye !== true);
  if (!aTraiter.length) return;

  const titres = {
    hebdo:         'Rappel hebdomadaire — Commission Témoignage',
    visite_mois:   'Rappel visite mensuelle — Commission Témoignage',
    sortie:        'Sortie collective — Commission Témoignage',
    action_prevue: 'Rendez-vous dans 2 jours — Commission Témoignage',
    manuel:        'Message — Commission Témoignage',
  };

  for (const doc of aTraiter) {
    const c = doc.data();
    // Un message "manuel" programmé pour plus tard ne doit pas livrer sa
    // bannière avant sa date, même si pushDemande a été posé à l'avance.
    if (c.programmePour && new Date(c.programmePour).getTime() > now.getTime()) continue;
    const titre = c.objet ? `✍️ ${c.objet}` : (titres[c.type] || 'Commission Témoignage');
    const corps = (c.contenu || '').split('\n').find(l => l.trim()) || 'Voir l\'application pour le détail.';
    const ok = await sendPush(c.evId, titre, corps);
    await doc.ref.update({
      pushEnvoye: true, // marqué "traité" même en cas d'échec (abonnement absent/expiré), pour ne pas boucler indéfiniment
      pushEnvoyeAt: admin.firestore.FieldValue.serverTimestamp(),
      pushLivre: ok,
    });
    console.log(`${ok ? '✔' : '·'} Push ${ok ? 'livré' : 'non livré (pas d\'abonnement actif)'} — ${c.evNom || c.evId}`);
  }
}

(async () => {
  const now = new Date();
  console.log('▶ Vérification des rappels —', now.toISOString());
  await runRappelHebdo(now);
  await runRappelVisiteMensuelle(now);
  await runRappelActionPrevue(now);
  await runSortiesCollectives();
  await runPushDemandes(now);
  console.log('✔ Terminé.');
  process.exit(0);
})().catch(err => {
  console.error('❌ Erreur script rappels :', err);
  process.exit(1);
});
