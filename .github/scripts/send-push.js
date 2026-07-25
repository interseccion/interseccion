/**
 * Envía notificaciones Web Push (cifradas con VAPID) a los suscriptores
 * guardados en tu Google Sheet, consultados a través de tu Web App de GAS.
 *
 * Variables de entorno esperadas (todas vienen del workflow, desde Secrets):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ej. "mailto:tucorreo@ejemplo.com")
 *   GAS_URL       → URL de tu Web App de Apps Script (/exec)
 *   ADMIN_TOKEN   → el mismo token admin que usas en tu panel admin.html
 *   NOTIF_TITLE, NOTIF_BODY, NOTIF_URL, NOTIF_PUBIDS (coma-separado, vacío = todos)
 */

const webpush = require('web-push');

async function main() {
    const {
        VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
        GAS_URL, ADMIN_TOKEN,
        NOTIF_TITLE, NOTIF_BODY, NOTIF_URL, NOTIF_PUBIDS
    } = process.env;

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('Faltan las claves VAPID (¿configuraste los secrets del repo?).');
    if (!GAS_URL || !ADMIN_TOKEN) throw new Error('Falta GAS_URL o ADMIN_TOKEN (secrets del repo).');
    if (!NOTIF_TITLE || !NOTIF_BODY) throw new Error('Falta el título o el cuerpo de la notificación.');

    webpush.setVapidDetails(
        VAPID_SUBJECT || 'mailto:admin@example.com',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );

    console.log('📡 Pidiendo la lista de suscriptores a GAS...');
    const listRes = await fetch(`${GAS_URL}?action=getPushSubscribers&token=${encodeURIComponent(ADMIN_TOKEN)}`);
    const subscribers = await listRes.json();
    if (!Array.isArray(subscribers)) {
        throw new Error('Error al obtener suscriptores de GAS: ' + JSON.stringify(subscribers));
    }

    const wantedIds = (NOTIF_PUBIDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const targets = wantedIds.length
        ? subscribers.filter(s => wantedIds.includes(s.pubId))
        : subscribers;

    console.log(`👥 Enviando a ${targets.length} de ${subscribers.length} suscriptor(es) totales.`);
    if (targets.length === 0) {
        console.log('⚠️ No hay a quién enviar (0 suscriptores en el segmento). Terminando sin error.');
        return;
    }

    const payload = JSON.stringify({
        title: NOTIF_TITLE,
        body: NOTIF_BODY,
        url: NOTIF_URL || '/'
    });

    const deadEndpoints = [];
    let sent = 0, failed = 0;

    for (const sub of targets) {
        const pushSubscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        try {
            await webpush.sendNotification(pushSubscription, payload);
            sent++;
        } catch (err) {
            failed++;
            const statusCode = err.statusCode;
            console.error(`❌ Error enviando a ...${String(sub.endpoint).slice(-24)}: ${statusCode || err.message}`);
            // 404/410 = el navegador dio de baja esa suscripción (desinstaló, borró datos, etc.)
            if (statusCode === 404 || statusCode === 410) deadEndpoints.push(sub.endpoint);
        }
    }

    console.log(`✅ Enviadas: ${sent} · ❌ Fallidas: ${failed} · 🪦 Caducadas a borrar: ${deadEndpoints.length}`);

    if (deadEndpoints.length > 0) {
        console.log('🧹 Podando suscripciones caducadas en la hoja de cálculo...');
        const pruneRes = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' }, // evita el preflight CORS, igual que hace tu app
            body: JSON.stringify({ action: 'pruneDeadPushSubscriptions', token: ADMIN_TOKEN, endpoints: deadEndpoints })
        });
        console.log('Resultado de la poda:', await pruneRes.text());
    }

    if (failed > 0 && sent === 0) {
        process.exitCode = 1; // marca el job de Actions como fallido si no se envió ni una
    }
}

main().catch((err) => {
    console.error('💥 Error fatal:', err);
    process.exitCode = 1;
});
