const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

loadEnvFile(path.join(__dirname, ".env"));

console.log("[WALK FIRST ACTIVE VERSION]", {
  startedAt: new Date().toISOString()
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";
const root = __dirname;
const openaiApiKey = secretEnv("OPENAI_API_KEY");
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ollamaBaseUrl = String(process.env.OLLAMA_BASE_URL || "").trim().replace(/\/$/, "");
const ollamaModel = String(process.env.OLLAMA_MODEL || "").trim();
const vbnApiKey = secretEnv("VBN_OTP_API_KEY");
const vbnApiBase = process.env.VBN_OTP_API_BASE || "http://gtfsr.vbn.de/api";
const vbnRouterId = process.env.VBN_OTP_ROUTER_ID || "connect";
const vbnAuthScheme = process.env.VBN_OTP_AUTH_SCHEME ?? "";
const sessions = new Map();
const maxSessionMessages = 12;
const sessionTtlMs = 1000 * 60 * 60 * 6;
const openaiTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
const ollamaTimeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 60000);
const vbnTimeoutMs = Math.min(Number(process.env.VBN_OTP_TIMEOUT_MS || 5000), 5000);
const segmentAlternativesTimeoutMs = 2000;
const geocoderBaseUrl = String(process.env.GEOCODER_BASE_URL || "https://nominatim.openstreetmap.org/search").trim();
const geocoderTimeoutMs = Math.min(Number(process.env.GEOCODER_TIMEOUT_MS || 2500), 2500);
const geocoderUserAgent = String(process.env.GEOCODER_USER_AGENT || "oldenburg-transport-chatbot/1.0").trim();
const supportedAreas = [
  {
    name: "Oldenburg",
    state: "Niedersachsen",
    bounds: { minLat: 53.07, maxLat: 53.19, minLon: 8.10, maxLon: 8.32 }
  },
  {
    name: "Bremen",
    state: "Bremen",
    bounds: { minLat: 53.00, maxLat: 53.18, minLon: 8.65, maxLon: 8.95 }
  }
];
let stopsCache = { loadedAt: 0, stops: [] };
const stopsCacheTtlMs = 1000 * 60 * 60;
const placeCache = new Map();
const routeCache = new Map();
const routeCacheTtlMs = 1000 * 60 * 2;
const placeCacheTtlMs = 1000 * 60 * 15;

const supportedLanguageLabels = {
  en: "English", de: "Deutsch", ar: "العربية", tr: "Türkçe", uk: "Українська", hi: "हिन्दी"
};

function normalizeLanguage(value) {
  const map = {
    English: "en",
    Deutsch: "de",
    German: "de",
    العربية: "ar",
    Arabic: "ar",
    Türkçe: "tr",
    Turkish: "tr",
    Українська: "uk",
    Ukrainian: "uk",
    हिन्दी: "hi",
    Hindi: "hi"
  };
  const normalized = map[String(value || "").trim()] || String(value || "").trim() || "en";
  return supportedLanguageLabels[normalized] ? normalized : "en";
}

const serverStrings = {
  leaveAt:           { en: "Leave your location at {time}.", de: "Starten Sie um {time}.", ar: "ابدأ رحلتك في {time}.", tr: "Hareket saatiniz: {time}.", uk: "Вирушайте о {time}.", hi: "{time} पर निकलें।" },
  startAtStop:       { en: "Start at the stop {stop}. The first walk is shown as 0 minutes or is not in the route data.", de: "Beginnen Sie an der Haltestelle {stop}. Der erste Fußweg ist 0 Minuten oder fehlt.", ar: "ابدأ عند المحطة {stop}. المشي الأول 0 دقيقة أو غير مدرج.", tr: "{stop} durağından başlayın. İlk yürüyüş 0 dakika veya rota verilerinde yok.", uk: "Починайте на зупинці {stop}. Перший пішохідний відрізок — 0 хв або відсутній.", hi: "स्टॉप {stop} से शुरू करें। पहला पैदल मार्ग 0 मिनट है।" },
  noMappedWalking:   { en: "You should not need any mapped walking between the stops for this route.", de: "Für diese Route wird zwischen den Haltestellen kein Fußweg ausgewiesen.", ar: "لا يلزم المشي بين المحطات لهذا الطريق.", tr: "Bu rota için duraklar arasında yürüme gerekmez.", uk: "Для цього маршруту пішохідні відрізки між зупинками не потрібні.", hi: "इस रूट में स्टॉप के बीच कोई पैदल चलना नहीं होना चाहिए।" },
  finalWalkShort:    { en: "After you get off, the final walk is shown as 0 m or very short.", de: "Nach dem Aussteigen wird der letzte Fußweg als 0 m oder sehr kurz angezeigt.", ar: "بعد النزول، المشي الأخير 0 م أو قصير جداً.", tr: "İndikten sonra son yürüyüş 0 m veya çok kısa.", uk: "Після виходу остання пішохідна частина — 0 м або дуже коротка.", hi: "उतरने के बाद, अंतिम पैदल मार्ग 0 m या बहुत छोटा है।" },
  arriveAround:      { en: "Arrive around {time}", de: "Ankunft gegen {time}", ar: "الوصول حوالي {time}", tr: "Tahmini varış: {time}", uk: "Прибуття приблизно о {time}", hi: "लगभग {time} पर पहुँचें" },
  noTransferReq:     { en: "No transfer is required.", de: "Kein Umstieg erforderlich.", ar: "لا يلزم التبديل.", tr: "Aktarma gerekmez.", uk: "Пересадка не потрібна.", hi: "कोई बदलाव आवश्यक नहीं है।" },
  otherOptions:      { en: "Other options", de: "Weitere Optionen", ar: "خيارات أخرى", tr: "Diğer seçenekler", uk: "Інші варіанти", hi: "अन्य विकल्प" },
  validTicketQ:      { en: "Do you already have a valid ticket for this trip?", de: "Haben Sie bereits ein gültiges Ticket für diese Fahrt?", ar: "هل لديك تذكرة صالحة لهذه الرحلة؟", tr: "Bu yolculuk için geçerli biletiniz var mı?", uk: "У вас уже є дійсний квиток для цієї поїздки?", hi: "क्या आपके पास इस यात्रा के लिए पहले से वैध टिकट है?" },
  towardsH:          { en: "towards {h}", de: "Richtung {h}", ar: "باتجاه {h}", tr: "{h} yönünde", uk: "у напрямку {h}", hi: "{h} की ओर" },
  inDirectionShown:  { en: "in the direction shown on the vehicle display", de: "in der auf dem Display angezeigten Richtung", ar: "في الاتجاه المعروض على لوحة المركبة", tr: "araç ekranındaki yönde", uk: "у напрямку на табло", hi: "वाहन के डिस्प्ले पर दिखाई दिशा में" },
  comfortableConn:   { en: "This looks like a comfortable connection", de: "Das sieht nach einer komfortablen Verbindung aus", ar: "يبدو هذا اتصالاً مريحاً", tr: "Bu rahat bir bağlantı gibi görünüyor", uk: "Схоже на комфортну пересадку", hi: "यह एक आरामदायक कनेक्शन लगता है" },
  okayNotLate:       { en: "This looks okay, but do not leave late", de: "Das geht, aber brechen Sie nicht zu spät auf", ar: "يبدو مقبولاً، لكن لا تتأخر", tr: "Bu uygun ama geç ayrılmayın", uk: "Виглядає нормально, але не затримуйтесь", hi: "यह ठीक लगता है, लेकिन देर से न निकलें" },
  tightConn:         { en: "This is a tight connection", de: "Das ist eine knappe Verbindung", ar: "هذا وقت ضيق", tr: "Bu sıkışık bir bağlantı", uk: "Це тісна пересадка", hi: "यह एक तंग कनेक्शन है" },
  chooseEarlier:     { en: "If you can, choose an earlier route so you are not rushed.", de: "Wenn möglich, wählen Sie eine frühere Route.", ar: "إذا أمكنك، اختر طريقاً أبكر.", tr: "Mümkünse daha erken bir rota seçin.", uk: "Якщо можливо, оберіть ранніший маршрут.", hi: "यदि संभव हो, पहले का रूट चुनें।" },
  yesHaveTicket:     { en: "Yes, I have a ticket", de: "Ja, ich habe ein Ticket", ar: "نعم، لدي تذكرة", tr: "Evet, biletim var", uk: "Так, у мене є квиток", hi: "हाँ, मेरे पास टिकट है" },
  noNeedTicket:      { en: "No, I need a ticket", de: "Nein, ich brauche ein Ticket", ar: "لا، أحتاج إلى تذكرة", tr: "Hayır, biletime ihtiyacım var", uk: "Ні, мені потрібен квиток", hi: "नहीं, मुझे टिकट चाहिए" },
  notSure:           { en: "I am not sure", de: "Ich bin nicht sicher", ar: "لست متأكداً", tr: "Emin değilim", uk: "Я не впевнений", hi: "मुझे यकीन नहीं है" },
  openInMaps:        { en: "Open in Maps", de: "In Karten öffnen", ar: "فتح في الخريطة", tr: "Haritada aç", uk: "Відкрити на карті", hi: "मैप में खोलें" },
  noTransferLabel:   { en: "No transfer", de: "Kein Umstieg", ar: "بدون تبديل", tr: "Aktarmasız", uk: "Без пересадки", hi: "कोई बदलाव नहीं" },
  walkRoute:         { en: "Walking route", de: "Fußweg", ar: "طريق مشي", tr: "Yürüme rotası", uk: "Пішохідний маршрут", hi: "पैदल रूट" },
  foundLocAskDest:   { en: "I found your location. Where do you want to go? You can type a street, stop, landmark, or building name.", de: "Ich habe Ihren Standort gefunden. Wohin möchten Sie? Straße, Haltestelle, Wahrzeichen oder Gebäude.", ar: "لقد وجدت موقعك. إلى أين تريد الذهاب؟ يمكنك كتابة شارع أو محطة أو معلم.", tr: "Konumunuzu buldum. Nereye gitmek istiyorsunuz? Sokak, durak veya bina adı yazabilirsiniz.", uk: "Я знайшов вашу локацію. Куди ви хочете поїхати? Вулиця, зупинка або будівля.", hi: "मुझे आपका स्थान मिल गया। आप कहाँ जाना चाहते हैं? सड़क, स्टॉप या स्थलचिह्न का नाम लिखें।" },
  noWorriesStart:    { en: "No worries. Should I use your current location as the starting point?", de: "Kein Problem. Soll ich Ihren Standort als Startpunkt nutzen?", ar: "لا داعي للقلق. هل أستخدم موقعك كنقطة انطلاق؟", tr: "Sorun değil. Başlangıç için mevcut konumunuzu kullanayım mı?", uk: "Нічого страшного. Чи використати вашу локацію як відправну точку?", hi: "चिंता न करें। क्या मैं आपके वर्तमान स्थान को शुरुआती बिंदु के रूप में उपयोग करूँ?" },
  noWorriesDest:     { en: "No worries. What is the name or street of your dorm or destination?", de: "Kein Problem. Wie heißt Ihr Ziel oder Wohnheim?", ar: "لا داعي للقلق. ما اسم وجهتك؟", tr: "Sorun değil. Hedefinizin adı nedir?", uk: "Нічого страшного. Яка назва місця призначення?", hi: "चिंता न करें। आपके गंतव्य का नाम क्या है?" },
  noWorriesTime:     { en: "No worries. What time do you want to travel?", de: "Kein Problem. Um wie viel Uhr möchten Sie reisen?", ar: "لا داعي للقلق. في أي وقت تريد السفر؟", tr: "Sorun değil. Ne zaman seyahat etmek istiyorsunuz?", uk: "Нічого страшного. О якій годині ви хочете їхати?", hi: "चिंता न करें। आप किस समय यात्रा करना चाहते हैं?" },
  sureStart:         { en: "Sure. Should I use your current location as the starting point?", de: "Natürlich. Soll ich Ihren Standort als Startpunkt nutzen?", ar: "بالتأكيد. هل أستخدم موقعك كنقطة انطلاق؟", tr: "Tabii. Başlangıç için mevcut konumunuzu kullanayım mı?", uk: "Звичайно. Чи використати вашу локацію як відправну точку?", hi: "ज़रूर। क्या मैं वर्तमान स्थान को शुरुआती बिंदु के रूप में उपयोग करूँ?" },
  sureDest:          { en: "Sure. Where do you want to go in Oldenburg or Bremen?", de: "Natürlich. Wohin möchten Sie in Oldenburg oder Bremen?", ar: "بالتأكيد. إلى أين تريد في أولدنبورغ أو بريمن؟", tr: "Tabii. Oldenburg veya Bremen'de nereye gitmek istiyorsunuz?", uk: "Звичайно. Куди ви хочете в Ольденбурзі або Бремені?", hi: "ज़रूर। Oldenburg या Bremen में कहाँ जाना चाहते हैं?" },
  sureTime:          { en: "Sure. What time would you like to travel?", de: "Natürlich. Um wie viel Uhr möchten Sie fahren?", ar: "بالتأكيد. في أي وقت تريد السفر؟", tr: "Tabii. Ne zaman seyahat etmek istiyorsunuz?", uk: "Звичайно. О якій годині ви хочете їхати?", hi: "ज़रूर। आप किस समय यात्रा करना चाहते हैं?" },
  destSavedAskStart: { en: "Destination saved. Should I use your current location as the starting point?", de: "Ziel gespeichert. Soll ich Ihren Standort als Startpunkt nutzen?", ar: "تم حفظ الوجهة. هل أستخدم موقعك كنقطة انطلاق؟", tr: "Hedef kaydedildi. Başlangıç için mevcut konumunuzu kullanayım mı?", uk: "Пункт призначення збережено. Чи використати вашу локацію як відправну точку?", hi: "गंतव्य सहेजा गया। क्या मैं वर्तमान स्थान को शुरुआती बिंदु के रूप में उपयोग करूँ?" },
  startSavedAskDest: { en: "Starting point saved. Where do you want to go?", de: "Startpunkt gespeichert. Wohin möchten Sie fahren?", ar: "تم حفظ نقطة الانطلاق. إلى أين تريد الذهاب؟", tr: "Başlangıç noktası kaydedildi. Nereye gitmek istiyorsunuz?", uk: "Відправну точку збережено. Куди ви хочете поїхати?", hi: "शुरुआती बिंदु सहेजा गया। आप कहाँ जाना चाहते हैं?" },
  startSavedAskTime: { en: "Starting point saved. What time would you like to travel?", de: "Startpunkt gespeichert. Um wie viel Uhr möchten Sie fahren?", ar: "تم حفظ نقطة الانطلاق. في أي وقت تريد السفر؟", tr: "Başlangıç noktası kaydedildi. Ne zaman seyahat etmek istiyorsunuz?", uk: "Відправну точку збережено. О якій годині ви хочете їхати?", hi: "शुरुआती बिंदु सहेजा गया। आप किस समय यात्रा करना चाहते हैं?" },
  destSaved:         { en: "Destination saved.", de: "Ziel gespeichert.", ar: "تم حفظ الوجهة.", tr: "Hedef kaydedildi.", uk: "Пункт призначення збережено.", hi: "गंतव्य सहेजा गया।" },
  startSaved:        { en: "Starting point saved.", de: "Startpunkt gespeichert.", ar: "تم حفظ نقطة الانطلاق.", tr: "Başlangıç noktası kaydedildi.", uk: "Відправну точку збережено.", hi: "शुरुआती बिंदु सहेजा गया।" },
  useCurrentLoc:     { en: "Use my current location", de: "Meinen Standort nutzen", ar: "استخدام موقعي الحالي", tr: "Mevcut konumumu kullan", uk: "Використати мою поточну локацію", hi: "मेरा वर्तमान स्थान उपयोग करें" },
  typeLocManually:   { en: "Enter location manually", de: "Standort manuell eingeben", ar: "أدخل الموقع يدوياً", tr: "Konumu manuel gir", uk: "Ввести місце вручну", hi: "स्थान मैन्युअली दर्ज करें" },
  askRouteOrigin:    { en: "Where are you starting from?", de: "Von wo starten Sie?", ar: "من أين تبدأ؟", tr: "Nereden başlıyorsunuz?", uk: "Звідки ви починаєте?", hi: "आप कहाँ से शुरू कर रहे हैं?" },
  askRouteOriginForDestination: { en: "You want to go to {destination}. Please choose your starting point:", de: "Sie möchten nach {destination}. Bitte wählen Sie Ihren Startpunkt:", ar: "تريد الذهاب إلى {destination}. يرجى اختيار نقطة البداية:", tr: "{destination} hedefine gitmek istiyorsunuz. Lütfen başlangıç noktanızı seçin:", uk: "Ви хочете поїхати до {destination}. Будь ласка, оберіть початкову точку:", hi: "आप {destination} जाना चाहते हैं। कृपया अपना शुरुआती बिंदु चुनें:" },
  welcomeOldenburg:  { en: "👋 Welcome to Oldenburg!", de: "👋 Willkommen in Oldenburg!", ar: "👋 أهلاً بك في أولدنبورغ!", tr: "👋 Oldenburg'a hoş geldiniz!", uk: "👋 Ласкаво просимо до Ольденбурга!", hi: "👋 Oldenburg में आपका स्वागत है!" },
  welcomeBremen:     { en: "👋 Welcome to Bremen!", de: "👋 Willkommen in Bremen!", ar: "👋 أهلاً بك في بريمن!", tr: "👋 Bremen'e hoş geldiniz!", uk: "👋 Ласкаво просимо до Бремена!", hi: "👋 Bremen में आपका स्वागत है!" },
  welcomeGeneral:    { en: "👋 Welcome!", de: "👋 Willkommen!", ar: "👋 أهلاً وسهلاً!", tr: "👋 Hoş geldiniz!", uk: "👋 Ласкаво просимо!", hi: "👋 स्वागत है!" },
  keepSimple:        { en: "I'll keep it simple.", de: "Ich erkläre es einfach.", ar: "سأبقي الأمر بسيطاً.", tr: "Basit tutacağım.", uk: "Пояснюю просто.", hi: "मैं इसे सरल रखूँगा।" },
  showToDriver:      { en: "No worries. If you feel unsure, show this route to the driver or someone at the stop and ask for help.", de: "Keine Sorge. Wenn Sie unsicher sind, zeigen Sie diese Route dem Fahrpersonal oder einer Person an der Haltestelle.", ar: "لا تقلق. إذا كنت غير متأكد، أظهر هذا الطريق للسائق أو لشخص عند المحطة.", tr: "Merak etme. Emin değilseniz rotayı sürücüye veya duraktaki birine gösterin.", uk: "Не хвилюйтесь. Якщо сумніваєтесь, покажіть маршрут водієві або комусь на зупинці.", hi: "चिंता न करें। अनिश्चित हों तो यह मार्ग चालक या स्टॉप पर किसी को दिखाएं।" },
  locOutside:        { en: "That looks outside {areas}. Please choose a location in that area.", de: "Das liegt nicht in {areas}. Bitte nenne einen Ort in diesem Bereich.", ar: "يبدو ذلك خارج {areas}. يرجى اختيار موقع في تلك المنطقة.", tr: "Bu {areas} dışında görünüyor. Lütfen o bölgede bir konum seçin.", uk: "Це виглядає поза {areas}. Будь ласка, оберіть місце в цьому районі.", hi: "वह {areas} के बाहर लगता है। कृपया उस क्षेत्र में एक स्थान चुनें।" },
  locAmbiguous:      { en: "I found a few matching places. Which one do you mean?", de: "Ich habe mehrere passende Orte gefunden. Welchen meinst du?", ar: "وجدت عدة أماكن مطابقة. أيها تقصد؟", tr: "Birkaç eşleşen yer buldum. Hangisini kastediyorsunuz?", uk: "Я знайшов кілька відповідних місць. Яке ви маєте на увазі?", hi: "मुझे कुछ मेल खाने वाली जगहें मिलीं। आपका मतलब कौन सी है?" },
  missingApiKey:     { en: "The VBN OTP API is not configured yet. Set VBN_OTP_API_KEY on the server.", de: "Die VBN OTP API ist noch nicht konfiguriert. Setze VBN_OTP_API_KEY auf dem Server.", ar: "لم يتم تكوين VBN OTP API بعد. قم بتعيين VBN_OTP_API_KEY على الخادم.", tr: "VBN OTP API henüz yapılandırılmamış. Sunucuda VBN_OTP_API_KEY'i ayarlayın.", uk: "VBN OTP API ще не налаштовано. Встановіть VBN_OTP_API_KEY на сервері.", hi: "VBN OTP API अभी तक कॉन्फ़िगर नहीं है। सर्वर पर VBN_OTP_API_KEY सेट करें।" },
  vbnFetchError:     { en: "I could not fetch the VBN route right now. Please try again in a moment.", de: "Ich konnte die VBN Route gerade nicht abrufen. Bitte versuche es gleich noch einmal.", ar: "تعذر جلب طريق VBN الآن. يرجى المحاولة مرة أخرى.", tr: "VBN rotası şu an alınamıyor. Lütfen birazdan tekrar deneyin.", uk: "Не вдалося отримати маршрут VBN. Спробуйте знову за хвилину.", hi: "अभी VBN रूट नहीं मिल सका। कृपया एक पल बाद फिर कोशिश करें।" },
  noUsableRoute:     { en: "I found the locations, but VBN did not return a usable itinerary for that time.", de: "Ich habe die Orte gefunden, aber VBN hat für diese Zeit keine nutzbare Verbindung zurückgegeben.", ar: "وجدت المواقع، لكن VBN لم يرجع مساراً مناسباً لذلك الوقت.", tr: "Konumları buldum, ancak VBN bu saat için kullanılabilir bir güzergah döndürmedi.", uk: "Я знайшов місця, але VBN не повернув придатний маршрут на цей час.", hi: "मुझे जगहें मिल गईं, लेकिन VBN ने उस समय के लिए उपयोगी यात्रा-कार्यक्रम नहीं लौटाया।" },
  noPlaceSuggestions:{ en: "I could not find this place. Please enter the street address or choose a nearby stop.", de: "Ich konnte diesen Ort nicht finden. Bitte gib die Adresse ein oder wähle eine nahe Haltestelle.", ar: "لم أتمكن من العثور على هذا المكان. يرجى إدخال عنوان الشارع أو اختيار محطة قريبة.", tr: "Bu yeri bulamadım. Lütfen sokak adresini girin veya yakındaki bir durağı seçin.", uk: "Я не зміг знайти це місце. Введіть адресу або виберіть найближчу зупинку.", hi: "मैं यह जगह नहीं ढूंढ पाया। कृपया सड़क का पता दर्ज करें या पास का स्टॉप चुनें।" },
  exactAddressNotFound: { en: "I could not find that house number exactly. Please choose the street, its bus stop, or enter another address.", de: "Ich konnte diese Hausnummer nicht genau finden. Bitte wählen Sie die Straße, die Haltestelle oder geben Sie eine andere Adresse ein.", ar: "لم أتمكن من العثور على رقم المنزل بدقة. اختر الشارع أو محطة الحافلة أو أدخل عنواناً آخر.", tr: "Bu kapı numarasını tam olarak bulamadım. Sokağı, otobüs durağını seçin veya başka bir adres girin.", uk: "Не вдалося точно знайти цей номер будинку. Виберіть вулицю, автобусну зупинку або введіть іншу адресу.", hi: "मुझे यह मकान नंबर ठीक से नहीं मिला। सड़क, बस स्टॉप चुनें या दूसरा पता दर्ज करें।" },
  aiSetupMissing:    { en: "The AI backend is not configured yet. Add OLLAMA_BASE_URL and OLLAMA_MODEL, or OPENAI_API_KEY, on the server and restart the app.", de: "Das KI-Backend ist noch nicht konfiguriert. Setze OLLAMA_BASE_URL und OLLAMA_MODEL oder OPENAI_API_KEY auf dem Server und starte die App neu.", ar: "لم يتم إعداد خلفية الذكاء الاصطناعي بعد. أضف OLLAMA_BASE_URL و OLLAMA_MODEL أو OPENAI_API_KEY على الخادم ثم أعد تشغيل التطبيق.", tr: "Yapay zeka backend'i henüz yapılandırılmadı. Sunucuda OLLAMA_BASE_URL ve OLLAMA_MODEL veya OPENAI_API_KEY ekleyip uygulamayı yeniden başlatın.", uk: "AI-бекенд ще не налаштовано. Додайте OLLAMA_BASE_URL і OLLAMA_MODEL або OPENAI_API_KEY на сервері та перезапустіть застосунок.", hi: "AI बैकएंड अभी कॉन्फ़िगर नहीं है। सर्वर पर OLLAMA_BASE_URL और OLLAMA_MODEL, या OPENAI_API_KEY जोड़ें और ऐप पुनः आरंभ करें।" },
  outOfScope:        { en: "I can help with public transport in Oldenburg and Bremen.", de: "Ich kann beim öffentlichen Nahverkehr in Oldenburg und Bremen helfen.", ar: "يمكنني المساعدة في النقل العام في أولدنبورغ وبريمن.", tr: "Oldenburg ve Bremen'deki toplu taşıma konusunda yardımcı olabilirim.", uk: "Я можу допомогти з громадським транспортом в Ольденбурзі та Бремені.", hi: "मैं Oldenburg और Bremen में सार्वजनिक परिवहन में मदद कर सकता हूँ।" },
  openAiAuthError:   { en: "The AI backend could not authenticate. Please check OPENAI_API_KEY in .env and restart the app.", de: "Das KI-Backend konnte sich nicht authentifizieren. Prüfe OPENAI_API_KEY in .env und starte die App neu.", ar: "تعذر على خلفية الذكاء الاصطناعي المصادقة. تحقق من OPENAI_API_KEY في .env ثم أعد تشغيل التطبيق.", tr: "Yapay zeka backend'i kimlik doğrulaması yapamadı. .env içindeki OPENAI_API_KEY değerini kontrol edip uygulamayı yeniden başlatın.", uk: "AI-бекенд не зміг пройти автентифікацію. Перевірте OPENAI_API_KEY у .env і перезапустіть застосунок.", hi: "AI बैकएंड प्रमाणित नहीं हो पाया। .env में OPENAI_API_KEY जाँचें और ऐप पुनः आरंभ करें।" },
  openAiReplyError:  { en: "The AI backend could not answer right now. Please check the OpenAI key, quota, and network connection.", de: "Das KI-Backend kann gerade nicht antworten. Prüfe OpenAI-Key, Kontingent und Netzwerkverbindung.", ar: "لا يمكن لخلفية الذكاء الاصطناعي الرد الآن. تحقق من مفتاح OpenAI والحصة والاتصال بالشبكة.", tr: "Yapay zeka backend'i şu anda yanıt veremiyor. OpenAI anahtarını, kotayı ve ağ bağlantısını kontrol edin.", uk: "AI-бекенд зараз не може відповісти. Перевірте ключ OpenAI, квоту та мережеве з'єднання.", hi: "AI बैकएंड अभी उत्तर नहीं दे पाया। OpenAI key, quota और नेटवर्क कनेक्शन जाँचें।" },
  ollamaReplyError:  { en: "The Ollama backend could not answer right now. Please check that Ollama is running, the model is pulled, and OLLAMA_BASE_URL is correct.", de: "Das Ollama-Backend kann gerade nicht antworten. Prüfe, ob Ollama läuft, das Modell geladen ist und OLLAMA_BASE_URL stimmt.", ar: "لا يمكن لخلفية Ollama الرد الآن. تحقق من تشغيل Ollama وتنزيل النموذج وصحة OLLAMA_BASE_URL.", tr: "Ollama backend'i şu anda yanıt veremiyor. Ollama'nın çalıştığını, modelin indirildiğini ve OLLAMA_BASE_URL değerinin doğru olduğunu kontrol edin.", uk: "Бекенд Ollama зараз не може відповісти. Перевірте, чи запущено Ollama, чи завантажена модель і чи правильний OLLAMA_BASE_URL.", hi: "Ollama बैकएंड अभी उत्तर नहीं दे पाया। जाँचें कि Ollama चल रहा है, model डाउनलोड हो चुका है, और OLLAMA_BASE_URL सही है।" },
  safeProcessError:  { en: "Sorry, I could not process that safely right now. Please try again.", de: "Entschuldigung, ich konnte das gerade nicht sicher verarbeiten. Bitte versuche es erneut.", ar: "عذراً، لم أتمكن من معالجة ذلك بأمان الآن. يرجى المحاولة مرة أخرى.", tr: "Üzgünüm, bunu şu anda güvenli şekilde işleyemedim. Lütfen tekrar deneyin.", uk: "Вибачте, я не зміг безпечно обробити це зараз. Спробуйте ще раз.", hi: "माफ करें, मैं अभी इसे सुरक्षित रूप से संसाधित नहीं कर पाया। कृपया फिर कोशिश करें।" },
  timeAlreadyPassedChoose: { en: "{time} today has already passed. Do you want the next route now, tomorrow at {time}, or enter a different time?", de: "{time} Uhr heute ist bereits vorbei. Möchten Sie die nächste Verbindung jetzt, morgen um {time} Uhr oder eine andere Zeit eingeben?", ar: "لقد مرّ وقت الساعة {time} اليوم. هل تريد المسار التالي الآن، أو غدًا الساعة {time}، أو إدخال وقت آخر؟", tr: "Bugün saat {time} geçti. Şimdi sıradaki rotayı mı, yarın saat {time} rotasını mı görmek, yoksa farklı bir saat mi girmek istiyorsunuz?", uk: "Сьогодні {time} уже минуло. Хочете наступний маршрут зараз, завтра о {time} або ввести інший час?", hi: "आज {time} बजे का समय निकल चुका है। क्या आप अगला रूट अभी देखना चाहते हैं, कल {time} बजे का रूट देखना चाहते हैं, या कोई दूसरा समय दर्ज करना चाहते हैं?" },
  nextRouteNow:      { en: "Next route now", de: "Nächste Verbindung jetzt", ar: "أقرب رحلة الآن", tr: "Şimdi bir sonraki rota", uk: "Найближчий маршрут зараз", hi: "अभी अगला मार्ग" },
  tomorrowAtTime:    { en: "Tomorrow at {time}", de: "Morgen um {time}", ar: "غداً في {time}", tr: "Yarın {time}'da", uk: "Завтра о {time}", hi: "कल {time} बजे" },
  enterDifferentTime:{ en: "Enter a different time", de: "Andere Zeit eingeben", ar: "إدخال وقت آخر", tr: "Farklı bir saat gir", uk: "Ввести інший час", hi: "दूसरा समय दर्ज करें" },
  typeDifferentTime: { en: "Please type a different time.", de: "Bitte geben Sie eine andere Zeit ein.", ar: "يرجى إدخال وقت آخر.", tr: "Lütfen farklı bir saat girin.", uk: "Будь ласка, введіть інший час.", hi: "कृपया कोई दूसरा समय दर्ज करें।" },
  invalidPastDateTime:{ en: "That date or time is in the past. Please enter a future date and time.", de: "Dieses Datum oder diese Uhrzeit liegt in der Vergangenheit. Bitte geben Sie ein zukünftiges Datum und eine zukünftige Uhrzeit ein.", ar: "هذا التاريخ أو الوقت مضى. يرجى إدخال تاريخ ووقت في المستقبل.", tr: "Bu tarih veya saat geçmişte. Lütfen gelecekteki bir tarih ve saat girin.", uk: "Ця дата або час уже минули. Введіть майбутню дату й час.", hi: "यह तारीख या समय बीत चुका है। कृपया भविष्य की तारीख और समय दर्ज करें।" },
  didYouMeanThesePlaces: { en: "Did you mean one of these?", de: "Meinten Sie eines dieser Ziele?", ar: "هل تقصد أحد هذه الأماكن؟", tr: "Bunlardan birini mi kastettiniz?", uk: "Можливо, ви мали на увазі одне з цих місць?", hi: "क्या आपका मतलब इनमें से किसी जगह से है?" },
  useThesePlaces:    { en: "Yes, plan route", de: "Ja, Route planen", ar: "نعم، خطط الطريق", tr: "Evet, rota oluştur", uk: "Так, побудувати маршрут", hi: "हाँ, रूट बनाएं" },
  enterDifferentPlaces: { en: "Enter different places", de: "Andere Orte eingeben", ar: "إدخال أماكن مختلفة", tr: "Farklı yerler girin", uk: "Ввести інші місця", hi: "अलग जगहें दर्ज करें" },
  didYouMeanPlace:   { en: "I could not find '{original}'. Did you mean '{place}'?", de: "Ich konnte „{original}\" nicht finden. Meinten Sie „{place}\"?", ar: "لم أتمكن من العثور على '{original}'. هل تقصد '{place}'؟", tr: "'{original}' bulunamadı. '{place}' mi demek istediniz?", uk: "Не вдалося знайти «{original}». Можливо, ви мали на увазі «{place}»?", hi: "'{original}' नहीं मिला। क्या आपका मतलब '{place}' है?" },
  enterAnotherDestination: { en: "Enter another destination", de: "Anderes Ziel eingeben", ar: "إدخال وجهة أخرى", tr: "Başka bir hedef girin", uk: "Ввести інше місце призначення", hi: "दूसरा गंतव्य दर्ज करें" },
  enterAnotherOrigin: { en: "Enter another starting point", de: "Anderen Startpunkt eingeben", ar: "إدخال نقطة انطلاق أخرى", tr: "Başka bir başlangıç noktası girin", uk: "Ввести іншу відправну точку", hi: "दूसरा शुरुआती बिंदु दर्ज करें" },
  usingCorrectedPlaces: { en: "Using {origin} and {destination}.", de: "Verwende {origin} und {destination}.", ar: "سيتم استخدام {origin} و{destination}.", tr: "{origin} ve {destination} kullanılıyor.", uk: "Використовую {origin} та {destination}.", hi: "{origin} और {destination} का उपयोग कर रहे हैं।" },
  destinationWalkNotice: { en: "Fastest route gets off at {stop}, then walk {minutes} minutes to {destination}.", de: "Die schnellste Route endet an der Haltestelle {stop}, dann gehen Sie {minutes} Minuten zu Fuß bis {destination}.", ar: "أسرع طريق ينزل عند محطة {stop}، ثم اسر {minutes} دقيقة إلى {destination}.", tr: "En hızlı rota {stop} durağında biter, sonra {destination}'a {minutes} dakika yürüyün.", uk: "Найшвидший маршрут закінчується на зупинці {stop}, потім йдіть {minutes} хвилин до {destination}.", hi: "सबसे तेज़ मार्ग {stop} स्टॉप पर उतरता है, फिर {destination} तक {minutes} मिनट पैदल चलें।" },
  routeDirectlyToStop: { en: "Route directly to {destination} stop", de: "Route direkt zur Haltestelle {destination}", ar: "طريق مباشر إلى محطة {destination}", tr: "{destination} durağına direkt rota", uk: "Маршрут прямо до зупинки {destination}", hi: "{destination} स्टॉप के लिए सीधा मार्ग" },
};

function ts(key, lang, params = {}) {
  const dict = serverStrings[key];
  if (!dict) { console.warn("[i18n Missing Key]", { key, selectedLanguage: lang }); return key; }
  let str = dict[lang] || dict.en;
  for (const [k, v] of Object.entries(params)) str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  return str;
}

function pluralMinutes(count, lang) {
  if (lang === "de") return count === 1 ? "Minute" : "Minuten";
  if (lang === "ar") return "دقيقة";
  if (lang === "tr") return "dakika";
  if (lang === "uk") return "хвилин";
  if (lang === "hi") return "मिनट";
  return count === 1 ? "minute" : "minutes";
}

function transferCountStr(count, lang) {
  if (count <= 0) return ts("noTransferLabel", lang);
  if (count === 1) return { de: "1 Umstieg", ar: "تبديل واحد", tr: "1 aktarma", uk: "1 пересадка", hi: "1 बदलाव", en: "1 transfer" }[lang] || "1 transfer";
  return { de: `${count} Umstiege`, ar: `${count} تبديلات`, tr: `${count} aktarma`, uk: `${count} пересадки`, hi: `${count} बदलाव`, en: `${count} transfers` }[lang] || `${count} transfers`;
}

function minWalkStr(minutes, lang) {
  return { de: `${minutes} Min. Fußweg`, ar: `${minutes} دقيقة مشياً`, tr: `${minutes} dk yürüyüş`, uk: `${minutes} хв пішки`, hi: `${minutes} मिनट पैदल`, en: `${minutes} min walk` }[lang] || `${minutes} min walk`;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function secretEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value || /^your-.+-key$/i.test(value) || /^replace-me$/i.test(value)) return "";
  if (name === "OPENAI_API_KEY" && !value.startsWith("sk-")) return "";
  return value;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const publicFiles = new Set([
  "index.html",
  "mock-payment.html",
  "bus-icon.svg",
  "bus-icon.png",
  "bus-icon-192.png",
  "manifest.webmanifest",
  "sw.js"
]);

function sendFile(req, res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function cacheKey(query) {
  return normalizePlaceKey(query);
}

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlaceKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bschiutzenweg\b/g, "schuetzenweg")
    .replace(/\bschutzenweg\b/g, "schuetzenweg")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUserInput(value) {
  return String(value || "")
    .replace(/\b([0-2]?\d)(?::([0-5]\d))?\s*a\.?\s*n\.?\b/gi, (_, hour, minute) => `${hour}${minute ? `:${minute}` : ""} am`)
    .replace(/\b([0-2]?\d)(?::([0-5]\d))?\s*a\.?\s*m\.?\b/gi, (_, hour, minute) => `${hour}${minute ? `:${minute}` : ""} am`)
    .replace(/\b([0-2]?\d)(?::([0-5]\d))?\s*p\.?\s*m\.?\b/gi, (_, hour, minute) => `${hour}${minute ? `:${minute}` : ""} pm`)
    .replace(/\b([0-2]?\d)(?::([0-5]\d))?(am|pm)\b/gi, (_, hour, minute, meridiem) => `${hour}${minute ? `:${minute}` : ""} ${meridiem.toLowerCase()}`)
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRouteCommandPhrases(value) {
  return String(value || "")
    .replace(/\b(?:give me the route|show me the route|find route|route please|please)\b/gi, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function isFuzzyMatch(input, candidate) {
  const normalizedInput = normalizeText(input);
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedInput || !normalizedCandidate) return false;
  if (normalizedInput.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedInput)) return true;

  const distance = levenshteinDistance(normalizedInput, normalizedCandidate);
  const maxDistance = normalizedInput.length <= 6 ? 1 : normalizedInput.length <= 12 ? 2 : 3;
  return distance <= maxDistance;
}

const placeCorrections = {
  "posternweg": "postenweg",
  "pfedermarkt": "pferdemarkt",
  "salbeisraße": "salbeistraße",
  "salbeisrasse": "salbeistrasse",
  "lapan": "lappan",
  "hauptbanhof": "hauptbahnhof"
};

const normalizedPlaceCorrections = Object.entries(placeCorrections).reduce((map, [from, to]) => {
  map[normalizePlaceKey(from)] = normalizePlaceKey(to);
  return map;
}, {});

function correctPlaceTypos(value) {
  const normalized = normalizePlaceKey(value);
  if (!normalized) return { corrected: false, text: String(value || "") };

  const words = normalized.split(" ");
  let corrected = false;
  const correctedWords = words.map(word => {
    const replacement = normalizedPlaceCorrections[word];
    if (replacement && replacement !== word) {
      corrected = true;
      return replacement;
    }
    return word;
  });

  if (!corrected) return { corrected: false, text: String(value || "") };
  return { corrected: true, text: correctedWords.join(" ") };
}

function areaForCoords(lat, lon) {
  return supportedAreas.find(area =>
    lat >= area.bounds.minLat
    && lat <= area.bounds.maxLat
    && lon >= area.bounds.minLon
    && lon <= area.bounds.maxLon
  ) || null;
}

function isInsideSupportedArea(lat, lon) {
  return Boolean(areaForCoords(lat, lon));
}

function supportedAreaNames() {
  return supportedAreas.map(area => area.name).join(" or ");
}

function distanceMeters(a, b) {
  if (!a || !b) return 0;
  const earthRadiusMeters = 6371000;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const knownPlaces = [
  {
    name: "Oldenburg Hauptbahnhof",
    lat: 53.14345,
    lon: 8.2221,
    aliases: ["oldenburg hbf", "oldenburg(oldb) hbf", "oldenburg hauptbahnhof", "bahnhof oldenburg", "oldenburg railway station", "railway station oldenburg", "oldenburg train station", "train station oldenburg", "oldenburg station"]
  },
  {
    name: "Universität Oldenburg, Campus Haarentor",
    lat: 53.1479,
    lon: 8.1837,
    aliases: ["universitat oldenburg", "universitaet oldenburg", "universität oldenburg campus haarentor", "universitaet oldenburg campus haarentor", "universitat oldenburg campus haarentor", "uni oldenburg", "university of oldenburg", "univesity of oldenburg", "university", "univesity", "uni", "uni campus haarentor", "uni campus harentor", "uni campus harrentor", "uni campus haarrentor", "university haarentor", "oldenburg university haarentor", "university oldenburg haarentor", "campus haarentor", "campus harentor", "campus harrentor", "campus haarrentor", "haarentor", "harentor", "harrentor", "haarrentor", "carl von ossietzky universität oldenburg haarentor campus", "carl von ossietzky universitaet oldenburg haarentor campus", "uhlhornsweg 49 oldenburg"]
  },
  {
    name: "Universität Oldenburg, Campus Wechloy",
    lat: 53.1532,
    lon: 8.1652,
    aliases: ["campus wechloy", "uni campus wechloy", "wechloy", "uni wechloy", "universitat wechloy", "universitaet wechloy", "universität oldenburg campus wechloy", "universitaet oldenburg campus wechloy", "carl von ossietzky universität oldenburg campus wechloy", "carl von ossietzky universitaet oldenburg campus wechloy", "oldenburg wechloy", "university oldenburg wechloy"]
  },
  {
    name: "Oldenburg Schlossplatz",
    lat: 53.1372,
    lon: 8.2148,
    aliases: ["schlossplatz", "oldenburg schloss", "innenstadt", "city center", "stadtmitte"]
  },
  {
    name: "Innenstadt Oldenburg",
    lat: 53.1395,
    lon: 8.2138,
    aliases: ["stadt oldenburg", "oldenburg city", "oldenburg innenstadt", "innenstadt oldenburg", "zentrum oldenburg", "city center oldenburg", "stadtmitte oldenburg"]
  },
  {
    name: "Rathaus Oldenburg",
    lat: 53.1387,
    lon: 8.2146,
    aliases: ["rathaus", "rathaus oldenburg", "stadt oldenburg rathaus", "stadtverwaltung oldenburg"]
  },
  {
    name: "Oldenburg ZOB",
    lat: 53.1431,
    lon: 8.2247,
    aliases: ["zob", "busbahnhof", "oldenburg zob", "zob oldenburg", "oldenburg(oldb) zob"]
  },
  {
    name: "Ausländerbehörde Oldenburg",
    lat: 53.1461,
    lon: 8.2149,
    aliases: ["ausländerbüro", "auslanderburo", "auslaenderbuero", "ausländerbehörde", "auslaenderbehoerde", "amt für zuwanderung und integration oldenburg", "amt fuer zuwanderung und integration oldenburg"]
  },
  {
    name: "Bürgerbüro Oldenburg",
    lat: 53.1462,
    lon: 8.2151,
    aliases: ["bürgerbüro", "burgerburo", "buergerbuero", "bürgerbüro oldenburg", "buergerbuero oldenburg", "bürgerbüro mitte oldenburg", "buergerbuero mitte oldenburg"]
  },
  {
    name: "Bürgerbüro Nord Oldenburg",
    lat: 53.1702,
    lon: 8.2136,
    aliases: ["bürgerbüro nord", "buergerbuero nord", "bürgerbüro nord oldenburg", "buergerbuero nord oldenburg"]
  },
  {
    name: "Studentenwohnheim Schützenweg Oldenburg",
    lat: 53.1481,
    lon: 8.1817,
    aliases: ["schützenweg student dorm", "schiützenweg student dorm", "schuetzenweg student dorm", "schutzenweg student dorm", "studentenwohnheim schützenweg", "studentenwohnheim schuetzenweg", "schützenweg oldenburg studentenwohnheim", "schuetzenweg oldenburg studentenwohnheim"]
  },
  {
    name: "Salbeistraße 24, Oldenburg",
    lat: 53.1427,
    lon: 8.1732,
    aliases: ["salbeistraße 24", "salbeistrasse 24", "salbeisraße 24", "salbeisrasse 24", "salbeistr 24", "salbeistrasse oldenburg 24"]
  },
  {
    name: "Oldenburg(Oldb) Pferdemarkt",
    lat: 53.146771,
    lon: 8.214682,
    stopId: "1:000009000881",
    aliases: ["pferdemarkt", "pferdemarkt oldenburg", "oldenburg pferdemarkt", "oldenburg(oldb) pferdemarkt"]
  },
  {
    name: "Oldenburg(Oldb) Postenweg",
    lat: 53.140881,
    lon: 8.171573,
    stopId: "1:000009090219",
    aliases: ["postenweg", "postenweg oldenburg", "oldenburg postenweg", "oldenburg(oldb) postenweg"]
  },
  {
    name: "Oldenburg Julius-Mosen-Platz",
    lat: 53.1381,
    lon: 8.2104,
    aliases: ["julius mosen platz", "julius-mosen-platz"]
  },
  {
    name: "Oldenburg(Oldb) Lappan",
    lat: 53.14332,
    lon: 8.214339,
    stopId: "1:000009000995",
    aliases: ["lappan", "lappan oldenburg", "oldenburg lappan", "oldenburg(oldb) lappan"]
  },
  {
    name: "Oldenburg Kreyenbrück",
    lat: 53.1126,
    lon: 8.2216,
    aliases: ["kreyenbruck", "kreyenbrueck", "kreyenbrück"]
  },
  {
    name: "Oldenburg Eversten",
    lat: 53.1316,
    lon: 8.1852,
    aliases: ["eversten", "oldenburg eversten"]
  },
  {
    name: "Klinikum Oldenburg",
    lat: 53.1217,
    lon: 8.2188,
    aliases: ["klinikum oldenburg", "hospital oldenburg", "krankenhaus oldenburg"]
  },
  {
    name: "Evangelisches Krankenhaus Oldenburg",
    lat: 53.1389,
    lon: 8.2189,
    aliases: ["evangelisches krankenhaus oldenburg", "ev oldenburg", "evangelical hospital oldenburg"]
  },
  {
    name: "Pius-Hospital Oldenburg",
    lat: 53.1418,
    lon: 8.2141,
    aliases: ["pius hospital oldenburg", "pius-hospital oldenburg", "pius oldenburg"]
  },
  {
    name: "Bremen Hauptbahnhof",
    lat: 53.0831,
    lon: 8.8137,
    aliases: ["bremen hbf", "bremen hauptbahnhof", "hauptbahnhof bremen", "bahnhof bremen", "bremen central station", "bremen railway station", "railway station bremen", "bremen train station", "train station bremen", "bremen station"]
  },
  {
    name: "Bremen Domsheide",
    lat: 53.0755,
    lon: 8.8085,
    aliases: ["domsheide", "bremen domsheide"]
  },
  {
    name: "Bremen Marktplatz",
    lat: 53.076,
    lon: 8.807,
    aliases: ["marktplatz bremen", "bremen marktplatz", "innenstadt bremen", "bremen innenstadt", "city center bremen"]
  },
  {
    name: "Universität Bremen",
    lat: 53.1065,
    lon: 8.8535,
    aliases: ["uni bremen", "university of bremen", "universitat bremen", "universitaet bremen", "bremen university"]
  },
  {
    name: "Bremen Viertel",
    lat: 53.0749,
    lon: 8.825,
    aliases: ["viertel", "das viertel", "ostertor", "steintor", "bremen viertel"]
  },
  {
    name: "Bremen Neustadt",
    lat: 53.0594,
    lon: 8.7935,
    aliases: ["neustadt bremen", "bremen neustadt"]
  }
];

const placeAliases = {
  "stadt oldenburg": [
    "Innenstadt Oldenburg",
    "Rathaus Oldenburg",
    "Schlossplatz Oldenburg",
    "Bürgerbüro Mitte Oldenburg",
    "Stadtverwaltung Oldenburg"
  ],
  "oldenburg city": [
    "Innenstadt Oldenburg",
    "Schlossplatz Oldenburg",
    "Rathaus Oldenburg"
  ],
  "city center": [
    "Innenstadt Oldenburg",
    "Schlossplatz Oldenburg",
    "Lappan Oldenburg"
  ],
  "zentrum": [
    "Innenstadt Oldenburg",
    "Schlossplatz Oldenburg",
    "Lappan Oldenburg"
  ],
  "innenstadt": [
    "Innenstadt Oldenburg",
    "Schlossplatz Oldenburg",
    "Lappan Oldenburg"
  ],
  "ausländerbüro": [
    "Ausländerbehörde Oldenburg",
    "Amt für Zuwanderung und Integration Oldenburg"
  ],
  "auslanderburo": [
    "Ausländerbehörde Oldenburg",
    "Amt für Zuwanderung und Integration Oldenburg"
  ],
  "auslaenderbuero": [
    "Ausländerbehörde Oldenburg",
    "Amt für Zuwanderung und Integration Oldenburg"
  ],
  "ausländerbehörde": [
    "Ausländerbehörde Oldenburg",
    "Ausländerbüro Oldenburg",
    "Amt für Zuwanderung und Integration Oldenburg"
  ],
  "auslaenderbehoerde": [
    "Ausländerbehörde Oldenburg",
    "Ausländerbüro Oldenburg",
    "Amt für Zuwanderung und Integration Oldenburg"
  ],
  "bürgerbüro": [
    "Bürgerbüro Oldenburg",
    "Bürgerbüro Mitte Oldenburg"
  ],
  "buergerbuero": [
    "Bürgerbüro Mitte Oldenburg",
    "Bürgerbüro Nord Oldenburg"
  ],
  "immigration office": [
    "Ausländerbehörde Oldenburg",
    "Amt für Zuwanderung und Integration Oldenburg"
  ],
  "rathaus": [
    "Rathaus Oldenburg",
    "Stadt Oldenburg Rathaus"
  ],
  "university oldenburg": [
    "Universität Oldenburg Campus Haarentor",
    "Universität Oldenburg Campus Wechloy"
  ],
  "oldenburg university": [
    "Universität Oldenburg Campus Haarentor",
    "Universität Oldenburg Campus Wechloy"
  ],
  "uni campus haarentor": [
    "Universität Oldenburg Campus Haarentor",
    "Carl von Ossietzky Universität Oldenburg Haarentor Campus",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "uni campus harentor": [
    "Universität Oldenburg Campus Haarentor",
    "Oldenburg(Oldb) Uni/Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "campus harentor": [
    "Universität Oldenburg Campus Haarentor",
    "Oldenburg(Oldb) Uni/Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "uni campus harrentor": [
    "Universität Oldenburg Campus Haarentor",
    "Carl von Ossietzky Universität Oldenburg Haarentor Campus",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "campus harrentor": [
    "Universität Oldenburg Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "uni campus haarrentor": [
    "Universität Oldenburg Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "campus haarrentor": [
    "Universität Oldenburg Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "university haarentor": [
    "Universität Oldenburg Campus Haarentor",
    "Carl von Ossietzky Universität Oldenburg Haarentor Campus",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "universität oldenburg campus haarentor": [
    "Carl von Ossietzky Universität Oldenburg Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "universitaet oldenburg campus haarentor": [
    "Carl von Ossietzky Universität Oldenburg Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "university oldenburg haarentor": [
    "Universität Oldenburg Campus Haarentor",
    "Carl von Ossietzky Universität Oldenburg Haarentor Campus",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "campus haarentor": [
    "Universität Oldenburg Campus Haarentor",
    "Uhlhornsweg 49 Oldenburg"
  ],
  "uni campus wechloy": [
    "Universität Oldenburg Campus Wechloy",
    "Carl von Ossietzky Universität Oldenburg Campus Wechloy"
  ],
  "campus wechloy": [
    "Universität Oldenburg Campus Wechloy"
  ],
  "student dorm schützenweg": [
    "Studentenwohnheim Schützenweg Oldenburg",
    "Schützenweg Oldenburg Studentenwohnheim"
  ],
  "schützenweg student dorm": [
    "Studentenwohnheim Schützenweg Oldenburg",
    "Schützenweg Oldenburg Studentenwohnheim"
  ],
  "schiützenweg student dorm": [
    "Studentenwohnheim Schützenweg Oldenburg",
    "Schützenweg Oldenburg Studentenwohnheim"
  ],
  "schuetzenweg student dorm": [
    "Studentenwohnheim Schützenweg Oldenburg",
    "Schützenweg Oldenburg Studentenwohnheim"
  ],
  "studentenwohnheim schützenweg": [
    "Studentenwohnheim Schützenweg Oldenburg",
    "Schützenweg Oldenburg Studentenwohnheim"
  ],
  "lappan": [
    "Oldenburg(Oldb) Lappan",
    "Lappan Oldenburg"
  ],
  "oldenburg lappan": [
    "Oldenburg(Oldb) Lappan",
    "Lappan Oldenburg"
  ],
  "لابان": [
    "Oldenburg(Oldb) Lappan",
    "Lappan Oldenburg"
  ],
  "लैपन": [
    "Oldenburg(Oldb) Lappan",
    "Lappan Oldenburg"
  ],
  "लप्पन": [
    "Oldenburg(Oldb) Lappan",
    "Lappan Oldenburg"
  ],
  "лаппан": [
    "Oldenburg(Oldb) Lappan",
    "Lappan Oldenburg"
  ],
  "train station": [
    "Oldenburg Hauptbahnhof",
    "Oldenburg(Oldb) Hbf",
    "Oldenburg(Oldb) ZOB"
  ],
  "railway station": [
    "Oldenburg Hauptbahnhof",
    "Oldenburg(Oldb) Hbf"
  ],
  "zob": [
    "Oldenburg(Oldb) ZOB",
    "ZOB Oldenburg"
  ],
  "zob oldenburg": [
    "Oldenburg(Oldb) ZOB",
    "ZOB Oldenburg"
  ],
  "hauptbahnhof": [
    "Oldenburg Hauptbahnhof",
    "Oldenburg(Oldb) Hbf"
  ],
  "postenweg": [
    "Oldenburg(Oldb) Postenweg",
    "Postenweg Oldenburg"
  ],
  "oldenburg postenweg": [
    "Oldenburg(Oldb) Postenweg",
    "Postenweg Oldenburg"
  ],
  "pferdemarkt": [
    "Oldenburg(Oldb) Pferdemarkt",
    "Pferdemarkt Oldenburg"
  ],
  "oldenburg pferdemarkt": [
    "Oldenburg(Oldb) Pferdemarkt",
    "Pferdemarkt Oldenburg"
  ],
  "salbeistraße": [
    "Salbeistraße Oldenburg"
  ],
  "salbeistrasse": [
    "Salbeistraße Oldenburg"
  ],
  "سالبيشتراسه": [
    "Salbeistraße Oldenburg"
  ],
  "साल्बेस्ट्रासे": [
    "Salbeistraße Oldenburg"
  ],
  "зальбайштрасе": [
    "Salbeistraße Oldenburg"
  ],
  "salbeistraße 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "salbeistrasse 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "salbeisraße 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "salbeisrasse 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "سالبيشتراسه 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "साल्बेस्ट्रासे 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "зальбайштрасе 24": [
    "Salbeistraße 24, Oldenburg",
    "Salbeistraße 24 26129 Oldenburg"
  ],
  "hospital": [
    "Klinikum Oldenburg",
    "Evangelisches Krankenhaus Oldenburg",
    "Pius-Hospital Oldenburg"
  ]
};

function aliasQueriesForPlaceExact(query) {
  const rawNormalized = String(query || "").toLowerCase().trim();
  const exactRaw = Object.entries(placeAliases).find(([key]) => key.toLowerCase().trim() === rawNormalized);
  if (exactRaw) return [...new Set(exactRaw[1])];

  const normalized = normalizePlaceKey(query);
  const matchingEntries = [];
  for (const [key, values] of Object.entries(placeAliases)) {
    const aliasKey = normalizePlaceKey(key);
    if (!normalized || !aliasKey) continue;
    if (normalized === aliasKey || normalized.includes(aliasKey) || aliasKey.includes(normalized)) {
      matchingEntries.push({ aliasKey, values });
    }
  }
  if (!matchingEntries.length) return [];
  const longestMatchLength = Math.max(...matchingEntries.map(entry => entry.aliasKey.length));
  const matches = [];
  for (const entry of matchingEntries) {
    if (entry.aliasKey.length === longestMatchLength) matches.push(...entry.values);
  }
  return [...new Set(matches)];
}

function aliasQueriesForPlace(query) {
  const exact = aliasQueriesForPlaceExact(query);
  if (exact.length) return exact;

  const correction = correctPlaceTypos(query);
  if (correction.corrected) {
    const correctedMatches = aliasQueriesForPlaceExact(correction.text);
    if (correctedMatches.length) return correctedMatches;
  }
  return [];
}

function placeQueryResolvesDirectly(value) {
  if (aliasQueriesForPlaceExact(value).length > 0) return true;
  return Boolean(resolveKnownPlace(value, { exactOnly: true }));
}

function fallbackPlaceQueries(query) {
  const cleaned = cleanRoutePlaceName(query);
  const withoutGermanArticle = cleaned.replace(/^(?:die|der|das|den|dem|des)\s+/i, "").trim();
  return [...new Set([
    cleaned,
    withoutGermanArticle,
    /\boldenburg\b/i.test(cleaned) ? cleaned : `${cleaned} Oldenburg`,
    withoutGermanArticle && !/\boldenburg\b/i.test(withoutGermanArticle) ? `${withoutGermanArticle} Oldenburg` : withoutGermanArticle
  ].filter(Boolean))];
}

function isAddressLikeQuery(query) {
  const value = String(query || "");
  return /\b(?:straße|strasse|str\.?|weg|allee|platz|ring|damm|chaussee)\s*\d+[a-z]?\b/i.test(value)
    || /\b\d+[a-z]?\s+(?:straße|strasse|str\.?|weg|allee|platz|ring|damm|chaussee)\b/i.test(value);
}

function hasHouseNumber(query) {
  return /\b\d+[a-zA-Z]?\b/.test(String(query || ""));
}

function looksLikeStreetAddress(query) {
  const value = String(query || "");
  return hasHouseNumber(value) && /(?:straße|strasse|str\.?|weg|platz|allee|ring|damm|ufer|chaussee)\b/iu.test(value);
}

function isStreetToStreetPlace(value) {
  const cleaned = cleanRoutePlaceName(value);
  if (!cleaned) return false;
  if (/(?:straße|strasse|str\.?|weg|platz|allee|ring)\b/iu.test(cleaned) || /\b\d+[a-z]?\b/i.test(cleaned)) return true;
  const known = resolveKnownPlace(cleaned, { exactOnly: true });
  return Boolean(known && (/(?:straße|strasse|str\.?|weg|platz|allee|ring)\b/iu.test(known.name) || /\b\d+[a-z]?\b/i.test(known.name)));
}

function isResolvableRoutePlace(value) {
  return isStreetToStreetPlace(value) || placeQueryResolvesDirectly(value);
}

function streetToStreetRouteFromText(rawText) {
  const value = normalizeUserInput(rawText).trim();
  const patterns = [
    {
      detectedPattern: "go_to_origin_to_destination",
      pattern: /^\s*(?:i\s+)?(?:want|need|would\s+like)\s+to\s+(?:go|get|travel|ride)\s+to\s+(.+?)\s+to\s+(.+?)(?=\s+(?:now|today|tomorrow|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b|[,.!?]|$)/i
    },
    {
      detectedPattern: "address_to_address",
      pattern: /^\s*(?!from\b)(.+?)\s+to\s+(.+?)(?=\s+(?:now|today|tomorrow)\b|[,.!?]|$)/i
    }
  ];

  for (const { pattern, detectedPattern } of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const possibleOriginText = cleanRoutePlaceName(match[1]);
    const possibleDestinationText = cleanRoutePlaceName(match[2]);
    const acceptsGeneralPlaces = detectedPattern === "go_to_origin_to_destination";
    const originResolvable = acceptsGeneralPlaces
      ? isResolvableRoutePlace(possibleOriginText)
      : isStreetToStreetPlace(possibleOriginText);
    const destinationResolvable = acceptsGeneralPlaces
      ? isResolvableRoutePlace(possibleDestinationText)
      : isStreetToStreetPlace(possibleDestinationText);
    const requestedDateTime = extractTimeText(value) || "now";
    const timeMode = TIME_MODE.DEPART_AT;

    if (acceptsGeneralPlaces) {
      console.log("[TO TO ROUTE PARSE DEBUG]", {
        rawText,
        detectedPattern,
        possibleOriginText,
        possibleDestinationText,
        originResolvable,
        destinationResolvable,
        originText: originResolvable && destinationResolvable ? possibleOriginText : null,
        destinationText: originResolvable && destinationResolvable ? possibleDestinationText : null,
        requestedDateTime,
        timeMode
      });
    }

    if (!originResolvable || !destinationResolvable) continue;
    const originText = possibleOriginText;
    const destinationText = possibleDestinationText;
    console.log("[STREET TO STREET PARSE DEBUG]", {
      rawText,
      originText,
      destinationText,
      requestedDateTime,
      timeMode,
      detectedPattern
    });
    return {
      start: originText,
      destination: destinationText,
      time: requestedDateTime,
      timeMode,
      confidence: 0.92
    };
  }
  return null;
}

const transitIntentPhrases = [
  "bus", "buses", "train", "tram", "public transport", "transit", "by bus", "take bus", "take a bus",
  "accessible", "accessibility", "wheelchair", "cannot walk", "can't walk", "avoid walking", "less walking",
  "mit dem bus", "mit bus", "bahn", "öffentliche verkehrsmittel", "oeffentliche verkehrsmittel", "barrierefrei",
  "rollstuhl", "ich kann nicht laufen", "wenig laufen", "nicht zu fuß", "nicht zu fuss",
  "حافلة", "باص", "قطار", "النقل العام", "بالمواصلات", "بالحافلة", "لا أستطيع المشي", "تجنب المشي", "كرسي متحرك", "مسار مناسب",
  "बस", "ट्रेन", "सार्वजनिक परिवहन", "बस से", "मैं ज्यादा नहीं चल सकता", "पैदल नहीं", "पैदल चलना कम", "व्हीलचेयर", "सुलभ मार्ग",
  "автобус", "поїзд", "громадський транспорт", "автобусом", "не можу багато ходити", "не можу ходити", "уникати ходьби", "менше ходити", "інвалідний візок", "доступний маршрут",
  "otobüs", "tren", "toplu taşıma", "otobüsle", "yürüyemem", "yürümek istemiyorum", "az yürümek", "tekerlekli sandalye", "erişilebilir rota"
];

function normalizeIntentText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

function detectTransitIntent(rawText, selectedLanguage = "en") {
  const text = normalizeIntentText(rawText);
  const matchedPhrase = transitIntentPhrases.find(phrase => text.includes(normalizeIntentText(phrase))) || "";
  return {
    requested: Boolean(matchedPhrase),
    matchedPhrase,
    selectedLanguage: normalizeLanguage(selectedLanguage || "en")
  };
}

function decideRecommendedMode({ rawText, selectedLanguage, distanceMeters, estimatedWalkMinutes, userRequestedTransit }) {
  const transitIntent = detectTransitIntent(rawText, selectedLanguage);
  const requestedTransit = userRequestedTransit === true || transitIntent.requested;
  const isWalkable = Number(distanceMeters) <= 900 || Number(estimatedWalkMinutes) <= 12;
  return {
    recommendedMode: isWalkable && !requestedTransit ? "WALK" : "TRANSIT",
    reason: requestedTransit ? "user_requested_transit" : isWalkable ? "nearby_destination" : "not_walkable",
    isWalkable,
    userRequestedTransit: requestedTransit,
    matchedTransitPhrase: transitIntent.matchedPhrase
  };
}

function cleanPlaceName(value) {
  return cleanRouteCommandPhrases(normalizeUserInput(value))
    .replace(/[?.!,]+$/g, "")
    .replace(/\s+(?:at|around|by|um|gegen|ab)\s+[0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?\b.*$/i, "")
    .replace(/\b(can you|please|guide me|how to go|how do i go|get there|go there)$/i, "")
    .replace(/\b(?:harrentor|haarrentor)\b/i, "Haarentor")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRoutePlaceName(value) {
  return cleanPlaceName(value)
    .replace(/\b(?:today|tomorrow|tomorow|tommorow|morgen|now|jetzt)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRouteTimeText(value) {
  return extractTimeText(value) || extractMultilingualTimeText(value) || cleanPlaceName(value);
}

const TIME_MODE = {
  ARRIVE_BY: "ARRIVE_BY",
  DEPART_AT: "DEPART_AT"
};

function normalizeTimeMode(value) {
  return value === TIME_MODE.ARRIVE_BY ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT;
}

function inferTimeModeFromText(text) {
  const value = normalizeUserInput(text);
  if (/\bwant\s+to\s+be\s+there\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\b(?:have|need)\s+to\s+be\s+there\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\b(?:want|need)\s+to\s+be\s+(?:at|on|in)\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\bhave\s+to\s+be\s+(?:at|on|in)\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\bneed\s+to\s+arrive(?:\s+(?:at|on|in))?\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\bshould\s+reach\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\bhave\s+to\s+arrive\s+(?:at|on|in)?\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\bget\s+me\s+to\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\bby\s+[0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?\b/i.test(value)) return TIME_MODE.ARRIVE_BY;
  if (/\b(?:leave|start|depart)\s+at\b/i.test(value)) return TIME_MODE.DEPART_AT;
  if (/\bfrom\s+.+?\s+at\s+[0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?\b/i.test(value)) return TIME_MODE.DEPART_AT;
  if (/\bwant\s+to\s+go\s+at\b/i.test(value)) return TIME_MODE.DEPART_AT;
  return TIME_MODE.DEPART_AT;
}

function detectExplicitDate(text) {
  const value = normalizeUserInput(text);
  if (/\b(?:yesterday|gestern|dün)\b/i.test(value) || /(?:вчора|أمس|बीता\s+कल)/i.test(value)) return "yesterday";
  if (/\b(?:tomorrow|tomorow|tommorow|morgen|yarın)\b/i.test(value) || /(?:завтра|غد[ًاا]?|कल)/i.test(value)) return "tomorrow";
  if (/\b(?:today|heute|bugün|tonight|heute\s+abend|bu\s+gece)\b/i.test(value)
    || /(?:сьогодні|сьогодні\s+ввечері|اليوم|الليلة|आज|आज\s+रात)/i.test(value)) return "today";
  return "";
}

function extractTimeText(text) {
  const value = normalizeUserInput(text);
  const datePrefix = /\b(yesterday|gestern)\b/i.test(value)
    ? "yesterday "
    : /\b(tomorrow|tomorow|tommorow|morgen)\b/i.test(value) ? "tomorrow "
    : /\b(today|heute|tonight)\b/i.test(value) ? "today " : "";
  const formatTime = rawTime => {
    const match = String(rawTime || "").trim().match(/^([0-2]?\d)(?::([0-5]\d))?\s*(am|pm)?$/i);
    if (!match) return String(rawTime || "").trim();
    const hour = Number(match[1]);
    const minute = match[2] || "00";
    const meridiem = match[3] ? ` ${match[3].toUpperCase()}` : "";
    return `${hour}:${minute}${meridiem}`;
  };
  const keywordMatch = value.match(/\b(?:at|around|by|um|gegen|ab)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\b/i);
  if (keywordMatch) return `${datePrefix}${formatTime(keywordMatch[1])}`.trim();

  const explicitMatch = value.match(/\b([0-2]?\d:[0-5]\d\s*(?:am|pm)?|(?:1[0-2]|[1-9])\s*(?:am|pm))\b/i);
  return explicitMatch ? `${datePrefix}${formatTime(explicitMatch[1])}`.trim() : "";
}

function formatParsedTime(hour, minute = "00", meridiem = "") {
  const numericHour = Number(hour);
  const safeMinute = String(minute || "00").padStart(2, "0");
  const suffix = meridiem ? ` ${String(meridiem).toUpperCase()}` : "";
  return `${numericHour}:${safeMinute}${suffix}`;
}

function extractMultilingualTimeText(text) {
  const value = normalizeUserInput(text).replace(/[،؛]/g, " ");
  const latin = extractTimeText(value);
  const tomorrowPrefix = /(?:غد[ًاا]?|कल|завтра|\byarın\b)/i.test(value) ? "tomorrow " : "";
  const pastPrefix = /(?:أمس|вчора|\bdün\b)/i.test(value) ? "yesterday " : "";
  const datePrefix = pastPrefix || tomorrowPrefix;
  if (latin) return `${datePrefix}${latin}`.trim();

  const uhrMatch = value.match(/\b([0-2]?\d)(?::([0-5]\d))?\s*uhr\b/i);
  if (uhrMatch) return `${datePrefix}${formatParsedTime(uhrMatch[1], uhrMatch[2])}`.trim();

  const ukrainianHourMatch = value.match(/(?:^|\s)о\s*([0-2]?\d)(?::([0-5]\d))?\s*(?:ранку|дня|вечора)?/i);
  if (ukrainianHourMatch) return `${datePrefix}${formatParsedTime(ukrainianHourMatch[1], ukrainianHourMatch[2])}`.trim();

  const arabicHourMatch = value.match(/(?:الساعة|ساعة)\s*([0-2]?\d)(?::([0-5]\d))?/i);
  if (arabicHourMatch) {
    let hour = Number(arabicHourMatch[1]);
    if (/(?:مساء|مساءً)/.test(value) && hour < 12) hour += 12;
    if (/(?:صباح|صباحًا)/.test(value) && hour === 12) hour = 0;
    return `${datePrefix}${formatParsedTime(hour, arabicHourMatch[2])}`.trim();
  }

  const devanagariHourMatch = value.match(/(?:दोपहर\s*|शाम\s*|रात\s*)?([0-2]?\d)(?::([0-5]\d))?\s*बजे/i);
  if (devanagariHourMatch) {
    let hour = Number(devanagariHourMatch[1]);
    if (/(?:शाम|रात)/.test(value) && hour < 12) hour += 12;
    return `${datePrefix}${formatParsedTime(hour, devanagariHourMatch[2])}`.trim();
  }

  const turkishHourMatch = value.match(/\bsaat\s*([0-2]?\d)(?::([0-5]\d))?(?:['’](?:de|da|te|ta))?/i);
  if (turkishHourMatch) return `${datePrefix}${formatParsedTime(turkishHourMatch[1], turkishHourMatch[2])}`.trim();

  if (/(?:الآن|الان)/.test(value)) return "now";
  if (/\b(?:अब|अभी)\b/.test(value)) return "now";
  if (/\bзараз\b/.test(value)) return "now";

  return "";
}

function cleanMultilingualPlaceName(value) {
  return cleanRoutePlaceName(value)
    .replace(/^(?:der|die|das|den|dem|des|ein|eine|einer|einem|einen)\s+/i, "")
    .replace(/^(?:شارع)\s+/i, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bracketedLatinPlaces(text) {
  return [...String(text || "").matchAll(/\(([^()]*[A-Za-zÄÖÜäöüß][^()]*)\)/g)]
    .map(match => cleanMultilingualPlaceName(match[1]))
    .filter(Boolean);
}

function routeResultFromParts({ origin, destination, time, timeMode, confidence = 0.9 }) {
  const canonicalPlace = value => /^(?:لابان|لپان|लप्पन|लैपन|лаппан(?:і)?)$/i.test(String(value || "").trim()) ? "Lappan" : value;
  const cleanCanonicalPlace = value => canonicalPlace(
    cleanMultilingualPlaceName(value)
      .replace(/\s+(?:غد\S*|اليوم|कल|आज|завтра|сьогодні|yarın|bugün)$/i, "")
      .trim()
  );
  return {
    start: cleanCanonicalPlace(origin),
    destination: cleanCanonicalPlace(destination),
    time: time || "now",
    timeMode: normalizeTimeMode(timeMode),
    confidence
  };
}

function extractMultilingualTripDetails(text, selectedLanguage = "") {
  const raw = String(text || "");
  const value = cleanRouteCommandPhrases(normalizeUserInput(raw)).replace(/[–—]/g, "-");
  const time = extractMultilingualTimeText(value) || extractTimeText(value);
  const bracketed = bracketedLatinPlaces(value);
  const hasArabic = /[\u0600-\u06FF]/.test(value) || selectedLanguage === "ar";
  const hasHindi = /[\u0900-\u097F]/.test(value) || selectedLanguage === "hi";
  const hasUkrainian = /[\u0400-\u04FF]/.test(value) || selectedLanguage === "uk";

  const deadlinePatterns = [
    { pattern: /\bich\s+muss\s+(?:morgen|heute)?\s*um\s+[0-2]?\d(?::[0-5]\d)?\s*uhr\s+(?:am|an\s+der|in|beim)\s+(.+?)\s+sein\s+von\s+(.+?)(?=[,.!?;]|$)/i, destination: 1, origin: 2 },
    { pattern: /(?:يجب\s+أن\s+أكون|يجب\s+ان\s+اكون)\s+في\s+(.+?)(?=\s+(?:غد[ًاا]?|اليوم|الساعة|ساعة))\s+(?:غد[ًاا]?|اليوم)?\s*(?:الساعة|ساعة)\s*[0-2]?\d(?::[0-5]\d)?.*?\s+من\s+(.+?)(?=[،؛,.!?]|$)/i, destination: 1, origin: 2 },
    { pattern: /मुझे\s+(?:कल|आज)?\s*(?:सुबह|दोपहर|शाम|रात)?\s*[0-2]?\d(?::[0-5]\d)?\s*बजे\s+(.+?)\s+(?:पहुँचना|पहुंचना)\s+है\s*,?\s*(.+?)\s+से(?=[,.!?।]|$)/i, destination: 1, origin: 2 },
    { pattern: /(?:завтра|сьогодні)\s+я\s+маю\s+бути\s+(?:в|у)\s+(.+?)\s+о\s+[0-2]?\d(?::[0-5]\d)?\s*(?:ранку|дня|вечора)?\s+(?:із|з)\s+(.+?)(?=[,.!?;]|$)/i, destination: 1, origin: 2 },
    { pattern: /(?:yarın|bugün)\s+saat\s*[0-2]?\d(?::[0-5]\d)?(?:['’](?:de|da|te|ta))?\s+(.+?)(?:['’](?:da|de|ta|te))?\s+olmam\s+gerekiyor\s*,?\s*(.+?)(?:['’](?:den|dan|ten|tan))?(?=[,.!?;]|$)/i, destination: 1, origin: 2 }
  ];
  for (const item of deadlinePatterns) {
    const match = value.match(item.pattern);
    if (match && time) {
      return routeResultFromParts({
        origin: match[item.origin],
        destination: match[item.destination],
        time,
        timeMode: TIME_MODE.ARRIVE_BY,
        confidence: 0.97
      });
    }
  }

  // Shared destination-only forms used by the supported non-English parsers.
  // They intentionally return the same route shape as every other parser.
  if (hasArabic && time) {
    const match = value.match(/(?:أريد|اريد)\s+الذهاب\s+إلى\s+(.+?)(?=\s+(?:اليوم|غد[ًاا]?|الساعة)|[،؛,.!?]|$)/i);
    if (match) return routeResultFromParts({ origin: "", destination: /لابان|لپان/i.test(match[1]) ? "Lappan" : match[1], time, timeMode: TIME_MODE.DEPART_AT });
  }
  if (hasHindi && time && !/\sसे\s/.test(value)) {
    const match = value.match(/(?:मैं\s+)?(?:आज\s+)?(?:शाम\s+|रात\s+|सुबह\s+)?[0-2]?\d(?::[0-5]\d)?\s*बजे\s+(.+?)\s+जाना\s+चाहता/i);
    if (match) return routeResultFromParts({ origin: "", destination: /लप्पन|लैपन/i.test(match[1]) ? "Lappan" : match[1], time, timeMode: TIME_MODE.DEPART_AT });
  }
  if (hasUkrainian && time) {
    const match = value.match(/(?:я\s+хочу\s+)?поїхати\s+до\s+(.+?)(?=\s+(?:сьогодні|завтра|о\s+[0-2]?\d)|[,.!?;]|$)/i);
    if (match) return routeResultFromParts({ origin: "", destination: /лаппан/i.test(match[1]) ? "Lappan" : match[1], time, timeMode: TIME_MODE.DEPART_AT });
  }

  if (hasArabic && bracketed.length >= 2 && time) {
    return routeResultFromParts({
      origin: bracketed[1],
      destination: bracketed[0],
      time,
      timeMode: /(?:الوصول|أكون|للوصول)/.test(value) ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
      confidence: 0.96
    });
  }

  if (hasHindi && bracketed.length >= 2 && time) {
    return routeResultFromParts({
      origin: bracketed[0],
      destination: bracketed[1],
      time,
      timeMode: /(?:पहुँचना|पहुंचना)/.test(value) ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
      confidence: 0.96
    });
  }

  if (hasArabic && time) {
    const arrival = value.match(/(?:الوصول|أصل|اصل)\s+إلى\s+(.+?)\s+عند\s+الساعة\s+([0-2]?\d(?::[0-5]\d)?)\s*(?:ظهرًا|ظهرا)?\s*(?:انطلاقًا\s+)?من\s+(?:شارع\s+)?(.+?)(?=[،؛,.!?]|$)/i);
    if (arrival) {
      return routeResultFromParts({
        origin: arrival[3],
        destination: arrival[1],
        time: extractMultilingualTimeText(arrival[2]) || time,
        timeMode: TIME_MODE.ARRIVE_BY,
        confidence: 0.94
      });
    }

    const departure = value.match(/(?:الانطلاق|أريد\s+الانطلاق|اريد\s+الانطلاق)\s+(?:عند\s+)?الساعة\s+([0-2]?\d(?::[0-5]\d)?)\s*(?:ظهرًا|ظهرا)?\s+من\s+(?:شارع\s+)?(.+?)\s+إلى\s+(.+?)(?=[،؛,.!?]|$)/i);
    if (departure) {
      return routeResultFromParts({
        origin: departure[2],
        destination: departure[3],
        time: extractMultilingualTimeText(departure[1]) || time,
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.94
      });
    }
  }

  if (hasHindi && time) {
    const arrival = value.match(/([0-2]?\d(?::[0-5]\d)?(?:\s*बजे)?)\s+(.+?)\s+से\s+(.+?)\s+(?:पहुँचना|पहुंचना)\s+है/i);
    if (arrival) {
      return routeResultFromParts({
        origin: arrival[2],
        destination: arrival[3],
        time: extractMultilingualTimeText(arrival[1]) || time,
        timeMode: TIME_MODE.ARRIVE_BY,
        confidence: 0.94
      });
    }

    const departure = value.match(/([0-2]?\d(?::[0-5]\d)?(?:\s*बजे)?)\s+(.+?)\s+से\s+(.+?)\s+जाना\s+चाहता/i);
    if (departure) {
      return routeResultFromParts({
        origin: departure[2],
        destination: departure[3],
        time: extractMultilingualTimeText(departure[1]) || time,
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.94
      });
    }
  }

  if (hasUkrainian && time) {
    const arrival = value.match(/(?:я\s+хочу\s+)?бути\s+(?:в|у)\s+(.+?)\s+о\s+([0-2]?\d(?::[0-5]\d)?)\s+(?:із|з)\s+(.+?)(?=[,.!?;]|$)/i);
    if (arrival) {
      return routeResultFromParts({
        origin: arrival[3],
        destination: arrival[1],
        time: extractMultilingualTimeText(arrival[2]) || time,
        timeMode: TIME_MODE.ARRIVE_BY,
        confidence: 0.94
      });
    }

    const departure = value.match(/(?:я\s+хочу\s+)?вирушити\s+о\s+([0-2]?\d(?::[0-5]\d)?)\s+(?:із|з)\s+(.+?)\s+до\s+(.+?)(?=[,.!?;]|$)/i);
    if (departure) {
      return routeResultFromParts({
        origin: departure[2],
        destination: departure[3],
        time: extractMultilingualTimeText(departure[1]) || time,
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.94
      });
    }
  }

  // Arabic: destination-only and with-origin patterns that do not require a clock time.
  // Checked here so they also fire when time="now" (الآن) and when no time is given.
  if (hasArabic) {
    // Full route: "إلى [destination] (الآن) من [origin]"
    const arabicWithOrigin = value.match(/إلى\s+(.+?)\s+(?:(?:الآن|الان)\s+)?من\s+(.+?)(?=[،؛,.!?]|$)/i);
    if (arabicWithOrigin) {
      return routeResultFromParts({
        origin: arabicWithOrigin[2],
        destination: arabicWithOrigin[1],
        time: time || "now",
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.85
      });
    }
    // Destination-only: "إلى [destination]" — stop before time keyword or end of string
    const arabicDestOnly = value.match(/إلى\s+(.+?)(?=\s+(?:الآن|الان|عند\s+الساعة|الساعة)|[،؛,.!?]|$)/i);
    if (arabicDestOnly) {
      return routeResultFromParts({
        origin: "",
        destination: arabicDestOnly[1],
        time: time || "now",
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.82
      });
    }
  }

  // Hindi: destination-only and with-origin patterns that do not require a clock time.
  if (hasHindi) {
    // Full route: "[origin] से [destination] जाना"
    // Note: \b does not work with Devanagari; use (?=\s|$) instead.
    const hindiWithOrigin = value.match(/(?:(?:मैं|हम)\s+)?(.+?)\s+से\s+(.+?)\s+(?:जाना|पहुँचना|पहुंचना)(?=\s|$)/i);
    if (hindiWithOrigin) {
      return routeResultFromParts({
        origin: hindiWithOrigin[1],
        destination: hindiWithOrigin[2],
        time: time || "now",
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.85
      });
    }
    // Destination-only: "(मैं) (अब) [destination] जाना चाहता/ी"
    const hindiDestOnly = value.match(/(?:(?:मैं|हम)\s+)?(?:(?:अब|अभी)\s+)?(.+?)\s+(?:जाना|पहुँचना|पहुंचना)\s+(?:चाहता|चाहती|चाहते)(?=\s|$)/i);
    if (hindiDestOnly) {
      return routeResultFromParts({
        origin: "",
        destination: hindiDestOnly[1],
        time: time || "now",
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.82
      });
    }
  }

  // Ukrainian: destination-only and with-origin patterns that do not require a clock time.
  if (hasUkrainian) {
    // Full route: "(я хочу зараз поїхати) до [destination] із/з [origin]"
    const ukrainianWithOrigin = value.match(/(?:(?:я|ми)\s+)?(?:хочу\s+)?(?:зараз\s+)?(?:поїхати\s+)?до\s+(.+?)\s+(?:із|з)\s+(.+?)(?=[,.!?;]|$)/i);
    if (ukrainianWithOrigin) {
      return routeResultFromParts({
        origin: ukrainianWithOrigin[2],
        destination: ukrainianWithOrigin[1],
        time: time || "now",
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.85
      });
    }
    // Destination-only: "(я хочу зараз поїхати) до [destination]"
    const ukrainianDestOnly = value.match(/(?:(?:я|ми)\s+)?(?:хочу\s+)?(?:зараз\s+)?(?:поїхати\s+)?до\s+(.+?)(?=[,.!?;]|$)/i);
    if (ukrainianDestOnly) {
      return routeResultFromParts({
        origin: "",
        destination: ukrainianDestOnly[1],
        time: time || "now",
        timeMode: TIME_MODE.DEPART_AT,
        confidence: 0.82
      });
    }
  }

  const patterns = [
    {
      type: TIME_MODE.ARRIVE_BY,
      pattern: /\bich\s+möchte\s+um\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)\s+von\s+(?:der|die|das|den|dem|des)?\s*(.+?)\s+aus\s+am\s+(.+?)\s+sein\b/i,
      order: ["time", "origin", "destination"]
    },
    {
      type: TIME_MODE.ARRIVE_BY,
      pattern: /\bich\s+möchte\s+um\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)\s+am\s+(.+?)\s+sein\s*,?\s+von\s+(?:der|die|das|den|dem|des)?\s*(.+?)(?=[,.!?;]|$)/i,
      order: ["time", "destination", "origin"]
    },
    {
      type: TIME_MODE.ARRIVE_BY,
      pattern: /\bvon\s+(?:der|die|das|den|dem|des)?\s*(.+?)\s+(?:nach|zu|zur|zum)\s+(.+?)\s*,?\s*ankunft\s+um\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)/i,
      order: ["origin", "destination", "time"]
    },
    {
      type: TIME_MODE.ARRIVE_BY,
      pattern: /\bvon\s+(?:der|die|das|den|dem|des)?\s*(.+?)\s+(?:nach|zu|zur|zum)\s+(.+?)\s+bis\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)/i,
      order: ["origin", "destination", "time"]
    },
    {
      type: TIME_MODE.DEPART_AT,
      pattern: /\bich\s+möchte\s+um\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)\s+von\s+(?:der|die|das|den|dem|des)?\s*(.+?)\s+(?:nach|zu|zur|zum)\s+(.+?)\s+fahren\b/i,
      order: ["time", "origin", "destination"]
    },
    {
      type: TIME_MODE.DEPART_AT,
      pattern: /\bich\s+starte\s+um\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)\s+von\s+(?:der|die|das|den|dem|des)?\s*(.+?)\s+(?:nach|zu|zur|zum)\s+(.+?)(?=[,.!?;]|$)/i,
      order: ["time", "origin", "destination"]
    },
    {
      type: TIME_MODE.DEPART_AT,
      pattern: /\bvon\s+(?:der|die|das|den|dem|des)?\s*(.+?)\s+(?:nach|zu|zur|zum)\s+(.+?)\s+um\s+([0-2]?\d(?::[0-5]\d)?(?:\s*uhr)?)(?=[,.!?;]|$)/i,
      order: ["origin", "destination", "time"]
    }
  ];

  for (const item of patterns) {
    const match = value.match(item.pattern);
    if (!match) continue;
    const values = Object.fromEntries(item.order.map((name, index) => [name, match[index + 1]]));
    return routeResultFromParts({
      origin: values.origin,
      destination: values.destination,
      time: extractMultilingualTimeText(values.time) || extractTimeText(values.time),
      timeMode: item.type,
      confidence: 0.93
    });
  }

  return null;
}

function normalizeStationReference(value, fullMessage = "") {
  const text = normalizeText(value);
  const context = normalizeText(`${value} ${fullMessage}`);
  const mentionsStation = /\b(railway station|train station|station|bahnhof|hbf)\b/i.test(String(value || ""));

  if (!mentionsStation) return value;
  if (context.includes("bremen")) return "Bremen Hauptbahnhof";
  if (context.includes("oldenburg")) return "Oldenburg Hauptbahnhof";
  if (text === "railway station" || text === "train station" || text === "station" || text === "bahnhof" || text === "hbf") {
    return value;
  }
  return value;
}

function inferPlaceNameFromText(text) {
  const normalized = normalizeText(text)
    .replace(/\bunivesity\b/g, "university")
    .replace(/\buniversitaet\b/g, "universitat");

  const place = knownPlaces.find(item =>
    [item.name, ...item.aliases].some(alias => {
      const normalizedAlias = normalizeText(alias)
        .replace(/\bunivesity\b/g, "university")
        .replace(/\buniversitaet\b/g, "universitat");
      return normalized.includes(normalizedAlias);
    })
  );

  return place ? place.name : "";
}

function extractTripDetailsLegacy(text, selectedLanguage = "") {
  const rawText = String(text || "");
  const normalizedText = normalizeUserInput(rawText);
  const cleanedText = cleanRouteCommandPhrases(normalizedText);
  const multilingual = extractMultilingualTripDetails(rawText, selectedLanguage);
  if (multilingual) return multilingual;
  const streetToStreet = streetToStreetRouteFromText(rawText);
  if (streetToStreet) return streetToStreet;

  const destinationArrivalWithOrigin = cleanedText.match(/\b(?:i\s+)?want\s+to\s+be\s+(?:in|at)\s+(.+?)\s+(?:at|by)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm))(?:\s+(today|tomorrow))?\s+from\s+(.+?)(?=[,.!?]|$)/i);
  if (destinationArrivalWithOrigin) {
    return {
      start: cleanRoutePlaceName(destinationArrivalWithOrigin[4]),
      destination: cleanRoutePlaceName(destinationArrivalWithOrigin[1]),
      time: extractTimeText(cleanedText) || "now",
      timeMode: TIME_MODE.ARRIVE_BY,
      confidence: 0.94
    };
  }

  const destinationArrivalOnly = cleanedText.match(/\b(?:i\s+)?want\s+to\s+be\s+(?:in|at)\s+(.+?)\s+(?:at|by)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm))(?:\s+(today|tomorrow))?(?=[,.!?]|$)/i);
  if (destinationArrivalOnly) {
    return {
      start: "",
      destination: cleanRoutePlaceName(destinationArrivalOnly[1]),
      time: extractTimeText(cleanedText) || "now",
      timeMode: TIME_MODE.ARRIVE_BY,
      confidence: 0.94
    };
  }

  const patterns = [
    { type: "arrive_at_from", pattern: /\b(?:tomorrow|today|tonight)?\s*(?:i\s+)?(?:have|need)\s+to\s+be\s+there\s+(?:at|in|on)\s+(.+?)\s+(?:at|by)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+from\s+(.+?)(?=[,.!?]|$)/i },
    { type: "arrive_at_from", pattern: /\b(?:tomorrow|today|tonight)?\s*(?:i\s+)?(?:have|need)\s+to\s+be\s+(?:at|in|on)\s+(.+?)\s+(?:at|by)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+from\s+(.+?)(?=[,.!?]|$)/i },
    { type: "arrive_at_from", pattern: /\b(?:tomorrow|today|tonight)?\s*(?:i\s+)?need\s+to\s+arrive\s+(?:at|in|on)\s+(.+?)\s+by\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+from\s+(.+?)(?=[,.!?]|$)/i },
    { type: "arrive_at_from", pattern: /\b(?:i\s+)?(?:(?:want|need)\s+to\s+be|should\s+reach|have\s+to\s+arrive|get\s+me\s+to)\s+(?:at|on|in|to)?\s*(.+?)\s+(?:at|by)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+from\s+(.+?)(?=[,.!?]|$)/i },
    { type: "depart_reach", pattern: /\b(?:i\s+)?(?:want\s+to\s+)?(?:start|leave|depart)\s+at\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+from\s+(.+?)\s+(?:to\s+reach|reach|arrive\s+at|get\s+to|to)\s+(.+?)(?=[,.!?]|$)/i },
    { type: "depart_reach", pattern: /\b(?:i\s+)?(?:want\s+to\s+)?(?:start|leave|depart)\s+from\s+(.+?)\s+at\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+(?:to\s+reach|reach|arrive\s+at|get\s+to|to)\s+(.+?)(?=[,.!?]|$)/i, order: ["origin", "time", "destination"] },
    { type: "depart_reach", pattern: /\b(?:i\s+)?(?:want\s+to\s+)?(?:leave|start|depart)\s+(.+?)\s+at\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+(?:and\s+)?(?:to\s+reach|reach|arrive\s+at|get\s+to|to)\s+(.+?)(?=[,.!?]|$)/i, order: ["origin", "time", "destination"] },
    { type: "to_at_from", pattern: /\b(?:i\s+)?(?:wan(?:t)?(?:\s+to)?|want(?:\s+to)?|need(?:\s+to)?|would\s+like\s+to)?\s*(?:go|get|travel|ride)?\s*to\s+(.+?)\s+(?:at|around|by|um|gegen|ab)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)\s+from\s+(.+?)(?=[,.!?]|$)/i },
    { type: "full_tail", pattern: /\bfrom\s+(.+?)\s+to\s+(.+?)(?=\s+(?:today|tomorrow|morgen|at|around|by|um|gegen|ab)\b|[,.!?]|$)(?:\s+(.+))?$/i },
    { type: "to_from", pattern: /\b(?:i\s+)?(?:wan(?:t)?(?:\s+to)?|want(?:\s+to)?|need(?:\s+to)?|would\s+like\s+to)?\s*(?:take\s+(?:a\s+)?bus|use\s+(?:public\s+)?transport|go\s+by\s+bus)\s+to\s+(.+?)\s+from\s+(.+?)(?=\s+(?:today|tomorrow|morgen|at|around|by|um|gegen|ab)\b|[,.!?]|$)(?:\s+(.+))?$/i },
    { type: "to_from", pattern: /\b(?:i\s+)?(?:wan(?:t)?(?:\s+to)?|want(?:\s+to)?|need(?:\s+to)?|would\s+like\s+to)?\s*(?:go|get|travel|ride)?\s*to\s+(.+?)\s+from\s+(.+?)(?=\s+(?:today|tomorrow|morgen|at|around|by|um|gegen|ab)\b|[,.!?]|$)(?:\s+(.+))?$/i },
    { type: "to_from", pattern: /\b(?:go|get|travel|ride|route)\s+to\s+(.+?)\s+from\s+(.+?)(?=\s+(?:today|tomorrow|morgen|at|around|by|um|gegen|ab)\b|[,.!?]|$)(?:\s+(.+))?$/i },
    { type: "to_from", pattern: /^\s*(?!from\b)(.+?)\s+from\s+(.+?)(?=\s+(?:today|tomorrow|morgen|at|around|by|um|gegen|ab)\b|[,.!?]|$)(?:\s+(.+))?$/i },
    { type: "full", pattern: /\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:at|around|by)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?))?(?:[,.].*)?$/i },
    { type: "full", pattern: /\bvon\s+(.+?)\s+(?:nach|zu|zur|zum)\s+(.+?)(?:\s+(?:um|gegen|ab)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?))?(?:[,.].*)?$/i },
    { type: "destination", pattern: /\b(?:same\s+starting\s+point|same\s+start|same\s+origin|from\s+the\s+same\s+place|from\s+same\s+place|from\s+there|gleicher\s+start|gleicher\s+startpunkt|vom\s+gleichen\s+ort|von\s+dort)\s+(?:to|nach|zur|zum)\s+(.+?)(?:\s+(?:at|around|by|um|gegen|ab)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?))?(?:[,.].*)?$/i },
    { type: "destination", pattern: /\b(?:i\s+)?(?:wan(?:t)?(?:\s+to)?|want(?:\s+to)?|need(?:\s+to)?|would\s+like\s+to)?\s*(?:go|get|travel|ride|route|fahrt|komme|fahren)\s+(?:to|nach|zur|zum)\s+(.+?)(?:\s+(?:at|around|by|um|gegen|ab)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?))?(?:[,.].*)?$/i },
    { type: "full", pattern: /^(?!.*\b(?:go|get|travel|ride|route|fahrt|komme|fahren)\s+(?:to|nach|zur|zum)\b)\b(.+?)\s+(?:to|nach|zur|zum)\s+(.+?)\s+(?:at|um|gegen|ab)\s+([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm)?)(?:[,.].*)?$/i },
    { type: "full", pattern: /\b(?:start|starting point|startpunkt)\s*:?\s*(.+?)\s+(?:destination|ziel|to|nach)\s*:?\s*(.+?)(?:\.|$)/i }
  ];

  for (const item of patterns) {
    const match = cleanedText.match(item.pattern);
    if (match) {
      if (item.type === "arrive_at_from") {
        return {
          start: cleanRoutePlaceName(match[3]),
          destination: cleanRoutePlaceName(match[1]),
          time: extractTimeText(cleanedText) || extractTimeText(match[2]) || "now",
          timeMode: TIME_MODE.ARRIVE_BY,
          confidence: 0.9
        };
      }

      if (item.type === "depart_reach") {
        const values = item.order
          ? Object.fromEntries(item.order.map((name, index) => [name, match[index + 1]]))
          : { time: match[1], origin: match[2], destination: match[3] };
        return {
          start: cleanRoutePlaceName(values.origin),
          destination: cleanRoutePlaceName(values.destination),
          time: extractTimeText(values.time) || extractTimeText(cleanedText) || "now",
          timeMode: TIME_MODE.DEPART_AT,
          confidence: 0.9
        };
      }

      if (item.type === "to_at_from") {
        return {
          start: cleanRoutePlaceName(match[3]),
          destination: cleanRoutePlaceName(match[1]),
          time: extractTimeText(cleanedText) || extractTimeText(match[2]) || "now",
          timeMode: TIME_MODE.DEPART_AT,
          confidence: 0.86
        };
      }

      if (item.type === "to_from") {
        return {
          start: cleanRoutePlaceName(match[2]),
          destination: cleanRoutePlaceName(match[1]),
          time: extractTimeText(match[3] || cleanedText) || "now",
          timeMode: inferTimeModeFromText(cleanedText),
          confidence: 0.8
        };
      }

      if (item.type === "full_tail") {
        return {
          start: cleanRoutePlaceName(match[1]),
          destination: cleanRoutePlaceName(match[2]),
          time: extractTimeText(match[3] || cleanedText) || "now",
          timeMode: inferTimeModeFromText(cleanedText),
          confidence: 0.8
        };
      }

      if (item.type === "destination") {
        return {
          start: "",
          destination: cleanRoutePlaceName(match[1]),
          time: cleanRouteTimeText(match[2]) || extractTimeText(cleanedText) || "now",
          timeMode: inferTimeModeFromText(cleanedText),
          confidence: 0.65
        };
      }

      return {
        start: cleanRoutePlaceName(match[1]),
        destination: cleanRoutePlaceName(match[2]),
        time: cleanRouteTimeText(match[3]) || extractTimeText(cleanedText) || "now",
        timeMode: inferTimeModeFromText(cleanedText),
        confidence: 0.75
      };
    }
  }

  return {
    start: "",
    destination: inferPlaceNameFromText(cleanedText),
    time: extractTimeText(cleanedText),
    timeMode: inferTimeModeFromText(cleanedText),
    confidence: 0.35
  };
}

function extractTripDetails(text, selectedLanguage = "") {
  const parsed = extractTripDetailsLegacy(text, selectedLanguage);
  const explicitDate = detectExplicitDate(text);
  const result = {
    ...parsed,
    originText: parsed.start || null,
    destinationText: parsed.destination || null,
    requestedDateTime: parsed.time || "now",
    explicitDate,
    selectedLanguage: normalizeLanguage(selectedLanguage || "en")
  };
  const noonMidnight = String(text || "").match(/\b(12)(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (noonMidnight) {
    const suffix = noonMidnight[3].toLowerCase();
    const parsedHour = suffix === "am" ? 0 : 12;
    console.log("[TIME PARSE 12PM DEBUG]", {
      rawText: text,
      rawTimeText: noonMidnight[0],
      parsedHour,
      parsedMinute: Number(noonMidnight[2] || 0),
      suffix,
      requestedDateTime: result.requestedDateTime,
      explicitDate: result.explicitDate,
      timeMode: result.timeMode
    });
  }
  return result;
}

function logRouteParseDebug(rawText, route, selectedLanguage = "") {
  const normalizedText = normalizeUserInput(rawText);
  const cleanedText = cleanRouteCommandPhrases(normalizedText);
  const originText = route.start || "";
  const destinationText = route.destination || "";
  const requestedDateTime = route.time || "";
  const payload = {
    selectedLanguage,
    rawText,
    originText,
    destinationText,
    requestedDateTime,
    timeMode: normalizeTimeMode(route.timeMode),
    confidence: Number(route.confidence) || 0
  };
  console.log("[Multilingual Parse Debug]", payload);
  console.log("[Route Parse Debug]", {
    rawText,
    cleanedText,
    normalizedText,
    originText,
    destinationText,
    requestedDateTime,
    timeMode: normalizeTimeMode(route.timeMode)
  });
  console.log("[DATE TIME PARSE DEBUG]", {
    rawText,
    originText,
    destinationText,
    requestedDateTime,
    explicitDate: route.explicitDate || detectExplicitDate(rawText),
    timeMode: normalizeTimeMode(route.timeMode)
  });
  if (["ar", "hi", "uk"].includes(selectedLanguage)) {
    console.log("[DESTINATION ONLY DEBUG]", {
      selectedLanguage,
      rawText,
      originText,
      destinationText,
      requestedDateTime,
      shouldAskOrigin: !originText && Boolean(destinationText)
    });
  }
}

function resolveKnownPlace(value, options = {}) {
  const normalized = normalizeText(value);
  const placeKey = normalizePlaceKey(value);
  if (!normalized) return null;

  const direct = knownPlaces.find(place =>
    [place.name, ...place.aliases].some(alias => normalizeText(alias) === normalized || normalizePlaceKey(alias) === placeKey)
  );
  if (direct) return direct;
  if (options.exactOnly) return null;

  return knownPlaces.find(place =>
    [place.name, ...place.aliases].some(alias => isFuzzyMatch(normalized, alias) || isFuzzyMatch(placeKey, normalizePlaceKey(alias)))
  ) || null;
}

function isVagueLocationQuery(value) {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length <= 1 && /^(station|bahnhof|hbf|uni|university|center|centre|innenstadt|stadtmitte|zob)$/.test(normalized)) return true;
  return /^(somewhere|anywhere|popular place|popular destination|tourist place|city center|center|centre|innenstadt|stadtmitte)$/.test(normalized);
}

function compactLocationName(displayName, fallback) {
  const parts = String(displayName || fallback || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
  if (!parts.length) return fallback || "";

  const first = parts[0];
  const area = supportedAreas.find(item => parts.some(part => normalizeText(part) === normalizeText(item.name)));
  return area && !normalizeText(first).includes(normalizeText(area.name))
    ? `${first}, ${area.name}`
    : first;
}

function normalizeGeocoderResult(item, originalQuery) {
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const area = areaForCoords(lat, lon);

  const address = item.address && typeof item.address === "object" ? item.address : {};
  const road = address.road || address.pedestrian || address.residential || address.path || "";
  const houseNumber = address.house_number || "";
  const city = address.city || address.town || address.village || address.municipality || (area ? area.name : "");
  const exactAddressName = road && houseNumber
    ? `${road} ${houseNumber}${city ? `, ${city}` : ""}`
    : "";

  return {
    name: exactAddressName || compactLocationName(item.display_name, originalQuery),
    displayName: item.display_name || originalQuery,
    lat,
    lon,
    area: area ? area.name : "",
    type: exactAddressName ? "address" : (item.type || item.class || "place"),
    address,
    importance: Number(item.importance) || 0
  };
}

function uniquePlaces(places) {
  const seen = new Set();
  return places.filter(place => {
    const key = `${normalizeText(place.name)}:${place.lat.toFixed(5)}:${place.lon.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function geocodeSupportedPlace(query) {
  if (!geocoderBaseUrl) return { ok: false, error: "geocoder_disabled", matches: [] };
  const debugQuery = /\b(oldenburg|bremen)\b/i.test(query)
    ? query
    : `${query} Oldenburg`;
  const queryVariants = uniquePlaces([
    { name: debugQuery, lat: 0, lon: 0 },
    { name: `${query}, Oldenburg, Niedersachsen, Germany`, lat: 0, lon: 0 },
    { name: `${query}, Bremen, Germany`, lat: 0, lon: 0 },
    { name: debugQuery.replace(/ß/g, "ss"), lat: 0, lon: 0 }
  ]).map(item => item.name);

  const rawUrl = new URL(geocoderBaseUrl);
  rawUrl.search = new URLSearchParams({
    format: "jsonv2",
    q: debugQuery,
    addressdetails: "1",
    limit: "1",
    countrycodes: "de"
  }).toString();

  const { response: rawResponse, data: rawData } = await fetchJsonWithTimeout(rawUrl, {
    headers: {
      "User-Agent": geocoderUserAgent,
      Accept: "application/json"
    }
  }, geocoderTimeoutMs);

  if (rawResponse.ok && Array.isArray(rawData) && rawData[0]) {
    const rawPlace = normalizeGeocoderResult(rawData[0], query);
    const rawName = compactLocationName(rawData[0].display_name, query);
    const rawClass = String(rawData[0].class || "");
    const rawType = String(rawData[0].type || "");
    const rawIsSettlement = rawClass === "boundary" || rawClass === "place"
      || ["city", "town", "village", "suburb", "municipality", "administrative"].includes(rawType);
    const rawLooksLikeDirectPlace = rawIsSettlement
      && rawPlace
      && !isInsideSupportedArea(rawPlace.lat, rawPlace.lon)
      && (isFuzzyMatch(query, rawName) || isFuzzyMatch(query, rawData[0].name || ""));

    if (rawLooksLikeDirectPlace) {
      return { ok: false, error: "outside_supported_area", matches: [] };
    }
  }

  const allMatches = [];
  for (const area of supportedAreas) {
    if (allMatches.length) break;
    for (const variant of queryVariants) {
      if (allMatches.length) break;
      for (const bounded of [true, false]) {
        if (allMatches.length) break;
        const url = new URL(geocoderBaseUrl);
        const params = {
          format: "jsonv2",
          q: bounded ? `${query}, ${area.name}, ${area.state}, Germany` : variant,
          addressdetails: "1",
          limit: "6",
          countrycodes: "de"
        };
        if (bounded) {
          params.bounded = "1";
          params.viewbox = `${area.bounds.minLon},${area.bounds.maxLat},${area.bounds.maxLon},${area.bounds.minLat}`;
        }
        url.search = new URLSearchParams(params).toString();

        const { response, data } = await fetchJsonWithTimeout(url, {
          headers: {
            "User-Agent": geocoderUserAgent,
            Accept: "application/json"
          }
        }, geocoderTimeoutMs);

        if (!response.ok || !Array.isArray(data)) continue;

        allMatches.push(...data
          .map(item => normalizeGeocoderResult(item, query))
          .filter(Boolean)
          .filter(place => isInsideSupportedArea(place.lat, place.lon)));
      }
    }
  }

  const matches = uniquePlaces(allMatches)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0));

  console.log("[Place Search Debug]", {
    query: debugQuery,
    results: matches.slice(0, 6).map(place => ({
      name: place.name,
      displayName: place.displayName,
      lat: place.lat,
      lon: place.lon,
      type: place.type,
      area: place.area
    }))
  });

  if (matches.length) return { ok: true, matches };

  return rawResponse.ok && Array.isArray(rawData) && rawData.length
    ? { ok: false, error: "outside_supported_area", matches: [] }
    : { ok: false, error: "unknown_supported_place", matches: [] };
}

async function isOutsideSupportedSettlement(query) {
  if (!geocoderBaseUrl) return false;

  const url = new URL(geocoderBaseUrl);
  url.search = new URLSearchParams({
    format: "jsonv2",
    q: query,
    addressdetails: "1",
    limit: "1",
    countrycodes: "de"
  }).toString();

  try {
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: {
        "User-Agent": geocoderUserAgent,
        Accept: "application/json"
      }
    }, geocoderTimeoutMs);

    if (!response.ok || !Array.isArray(data) || !data[0]) return false;
    const place = normalizeGeocoderResult(data[0], query);
    const rawName = compactLocationName(data[0].display_name, query);
    const rawClass = String(data[0].class || "");
    const rawType = String(data[0].type || "");
    const isSettlement = rawClass === "boundary" || rawClass === "place"
      || ["city", "town", "village", "suburb", "municipality", "administrative"].includes(rawType);

    return Boolean(isSettlement
      && place
      && !isInsideSupportedArea(place.lat, place.lon)
      && (isFuzzyMatch(query, rawName) || isFuzzyMatch(query, data[0].name || "")));
  } catch {
    return false;
  }
}

function normalizeStop(stop, origin) {
  const lat = Number(stop.lat ?? stop.stopLat);
  const lon = Number(stop.lon ?? stop.stopLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const area = areaForCoords(lat, lon);
  return {
    name: stop.name || stop.stopName || "",
    stopId: stop.id || stop.gtfsId || stop.stopId || "",
    lat,
    lon,
    area: area ? area.name : "",
    distanceMeters: origin ? Math.round(distanceMeters(origin, { lat, lon })) : 0,
    type: "stop"
  };
}

function locationChoice(place, fallbackLabel = "") {
  if (!place) return null;
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = place.name || fallbackLabel || "Selected place";
  const area = place.area || areaForCoords(lat, lon)?.name || "";
  const stop = Array.isArray(place.nearbyStops) ? place.nearbyStops[0] : null;
  const placeType = place.type || (place.stopId ? "stop" : "place");
  const stopId = place.stopId || (placeType === "stop" ? stop?.stopId : "") || "";

  return {
    label: area ? `${name} (${area})` : name,
    value: name,
    locationSelection: {
      placeId: place.placeId || place.id || stopId || `${normalizeText(name)}:${lat.toFixed(5)}:${lon.toFixed(5)}`,
      stopId,
      lat,
      lon,
      name,
      resolvedName: name,
      area,
      source: place.source || "",
      type: placeType,
      nearbyStops: Array.isArray(place.nearbyStops) ? place.nearbyStops.slice(0, 4) : []
    }
  };
}

async function allVbnStops() {
  if (!vbnApiKey) return [];
  if (stopsCache.stops.length && Date.now() - stopsCache.loadedAt < stopsCacheTtlMs) {
    return stopsCache.stops;
  }

  const url = new URL(`${vbnApiBase.replace(/\/$/, "")}/routers/${vbnRouterId}/index/stops`);
  try {
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: authHeaderValue(),
        Accept: "application/json"
      }
    }, vbnTimeoutMs);

    if (!response.ok || !Array.isArray(data)) return stopsCache.stops;

    stopsCache = {
      loadedAt: Date.now(),
      stops: data
        .map(stop => normalizeStop(stop))
        .filter(Boolean)
        .filter(stop => stop.name && isInsideSupportedArea(stop.lat, stop.lon))
    };
    return stopsCache.stops;
  } catch {
    return stopsCache.stops;
  }
}

async function searchVbnStopsByName(query) {
  const normalized = normalizeText(query);
  if (!normalized) return [];

  const stops = await allVbnStops();
  const scored = stops
    .map(stop => {
      const stopName = normalizeText(stop.name);
      const score = stopName === normalized
        ? 0
        : stopName.includes(normalized)
          ? 1
          : isFuzzyMatch(normalized, stopName)
            ? 2 + levenshteinDistance(normalized, stopName)
            : Infinity;
      return { stop, score };
    })
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.stop.name.localeCompare(b.stop.name));

  return uniquePlaces(scored.map(item => item.stop)).slice(0, 4);
}

function markPlaceSource(place, source) {
  return place ? { ...place, source } : place;
}

function resolvedPlaceFromKnown(known, source, nearbyStopsList = []) {
  if (!known) return null;
  const area = areaForCoords(known.lat, known.lon);
  return {
    name: known.name,
    lat: known.lat,
    lon: known.lon,
    area: area ? area.name : "",
    source,
    stopId: known.stopId || "",
    type: known.stopId ? "stop" : "place",
    nearbyStops: nearbyStopsList
  };
}

function uniqueLocationChoices(choices) {
  const seen = new Set();
  return (choices || []).filter(choice => {
    const selection = choice?.locationSelection || {};
    const lat = Number(selection.lat);
    const lon = Number(selection.lon);
    const key = `${normalizeText(selection.resolvedName || selection.name || choice.value || choice.label)}:${Number.isFinite(lat) ? lat.toFixed(5) : ""}:${Number.isFinite(lon) ? lon.toFixed(5) : ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scorePlaceMatch(place, originalQuery) {
  const placeText = normalizePlaceKey([place.name, place.displayName, place.area, place.type].filter(Boolean).join(" "));
  const queryWords = normalizePlaceKey(originalQuery).split(" ").filter(word => word.length > 1);
  const matchedWords = queryWords.filter(word => placeText.includes(word)).length;
  const wordScore = queryWords.length ? matchedWords / queryWords.length : 0;
  const areaScore = isInsideSupportedArea(Number(place.lat), Number(place.lon)) ? 0.25 : 0;
  const importanceScore = Math.min(0.25, Math.max(0, Number(place.importance) || 0) / 4);
  const typeScore = /office|public|city|townhall|hospital|university|station|stop|building|amenity|tourism|shop|healthcare|place|address/i.test(String(place.type || "")) ? 0.15 : 0;
  return wordScore + areaScore + importanceScore + typeScore;
}

function rankedChoicesFromPlaces(places, originalQuery, source) {
  return uniquePlaces(places)
    .map(place => ({
      ...markPlaceSource(place, place.source || source),
      score: scorePlaceMatch(place, originalQuery)
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.importance || 0) - (a.importance || 0))
    .map(place => locationChoice(place))
    .filter(Boolean);
}

function logSuggestionDebug(unresolvedField, suggestions) {
  console.log("[Suggestion Debug]", {
    unresolvedField,
    suggestions,
    suggestionsLength: suggestions?.length
  });
}

function suggestionChoicesFromResolution(resolution) {
  return (resolution?.choices || []).length ? resolution.choices : [];
}

async function nearbyVbnStops(place, radiusMeters = 650) {
  if (!vbnApiKey) return [];

  const url = new URL(`${vbnApiBase.replace(/\/$/, "")}/routers/${vbnRouterId}/index/stops`);
  url.search = new URLSearchParams({
    lat: String(place.lat),
    lon: String(place.lon),
    radius: String(radiusMeters)
  }).toString();

  try {
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: authHeaderValue(),
        Accept: "application/json"
      }
    }, vbnTimeoutMs);

    if (!response.ok || !Array.isArray(data)) return [];

    return uniquePlaces(data
      .map(stop => normalizeStop(stop, place))
      .filter(Boolean)
      .sort((a, b) => a.distanceMeters - b.distanceMeters))
      .slice(0, 4);
  } catch {
    return [];
  }
}

function requestedAddressParts(query) {
  const value = cleanRoutePlaceName(query);
  const houseMatch = value.match(/\b(\d+[a-zA-Z]?)\b/);
  return {
    houseNumber: houseMatch ? houseMatch[1].toLowerCase() : "",
    street: normalizePlaceKey(value.replace(/\b\d+[a-zA-Z]?\b/g, "").replace(/\boldenburg\b/gi, "").replace(/[,\s]+$/g, ""))
  };
}

function isStrongAddressMatch(place, query) {
  const requested = requestedAddressParts(query);
  const address = place?.address || {};
  const road = address.road || address.pedestrian || address.residential || address.path || "";
  const houseNumber = String(address.house_number || "").trim().toLowerCase();
  const city = address.city || address.town || address.village || address.municipality || place?.area || "";
  return Boolean(
    requested.street
    && requested.houseNumber
    && normalizePlaceKey(road) === requested.street
    && houseNumber === requested.houseNumber
    && normalizeText(city).includes("oldenburg")
    && Number.isFinite(Number(place?.lat))
    && Number.isFinite(Number(place?.lon))
  );
}

async function resolveExactStreetAddress(query) {
  const geocoded = await geocodeSupportedPlace(`${query}, Oldenburg`);
  const addressCandidates = geocoded.ok ? geocoded.matches : [];
  const selected = addressCandidates.find(candidate => isStrongAddressMatch(candidate, query)) || null;
  let selectedResult = null;
  if (selected) {
    selectedResult = {
      ...selected,
      type: "address",
      source: "address_geocoder",
      originalQuery: query,
      stopId: "",
      nearbyStops: await nearbyVbnStops(selected)
    };
  }
  console.log("[ADDRESS RESOLUTION DEBUG]", {
    rawQuery: query,
    normalizedQuery: normalizePlaceKey(query),
    hasHouseNumber: hasHouseNumber(query),
    looksLikeStreetAddress: looksLikeStreetAddress(query),
    addressCandidates: addressCandidates.map(candidate => ({
      name: candidate.name,
      lat: candidate.lat,
      lon: candidate.lon,
      address: candidate.address
    })),
    selectedResult,
    rejectedStopFallback: !selectedResult
  });
  return selectedResult;
}

async function resolveSupportedLocation(value, options = {}) {
  const query = cleanRoutePlaceName(value);
  if (!query) return { ok: false, error: "unknown_supported_place", aliasUsed: false, choices: [] };
  const strictAddress = looksLikeStreetAddress(query);
  const key = cacheKey(`${strictAddress ? "address" : "place"}:${query}`);
  const cached = cacheGet(placeCache, key);
  if (cached) return cached;

  if (strictAddress) {
    const address = await resolveExactStreetAddress(query);
    if (address) {
      return cacheSet(placeCache, key, {
        ok: true,
        source: "address_geocoder",
        aliasUsed: false,
        place: address,
        choices: [locationChoice(address)].filter(Boolean)
      }, placeCacheTtlMs);
    }
    return cacheSet(placeCache, key, {
      ok: false,
      error: "exact_address_not_found",
      aliasUsed: false,
      addressQuery: query,
      rejectedStopFallback: true,
      choices: []
    }, placeCacheTtlMs);
  }

  const aliasQueries = aliasQueriesForPlace(query);

  if (aliasQueries.length) {
    const aliasKnownPlaces = [];
    for (const aliasQuery of aliasQueries) {
      const aliasKnown = resolveKnownPlace(aliasQuery, { exactOnly: true }) || resolveKnownPlace(aliasQuery);
      if (!aliasKnown) continue;
      const stops = await nearbyVbnStops(aliasKnown);
      aliasKnownPlaces.push(resolvedPlaceFromKnown(aliasKnown, "alias_known_place", stops));
    }

    const aliasChoices = uniqueLocationChoices(
      aliasKnownPlaces.map(place => locationChoice(place)).filter(Boolean)
    );
    if (aliasChoices.length > 1 && options.allowAmbiguous) {
      return cacheSet(placeCache, key, {
        ok: false,
        error: "ambiguous_supported_place",
        aliasUsed: true,
        aliasQueries,
        choices: aliasChoices.slice(0, 5)
      }, placeCacheTtlMs);
    }

    if (aliasChoices.length === 1) {
      const selection = aliasChoices[0].locationSelection;
      const place = selectedPlaceFromPayload(selection);
      return cacheSet(placeCache, key, {
        ok: true,
        source: "alias_known_place",
        aliasUsed: true,
        aliasQueries,
        place,
        choices: aliasChoices
      }, placeCacheTtlMs);
    }
  }

  const known = resolveKnownPlace(query, { exactOnly: true });
  if (known) {
    const stops = await nearbyVbnStops(known);
    return cacheSet(placeCache, key, {
      ok: true,
      source: "known_place",
      place: resolvedPlaceFromKnown(known, "known_place", stops)
    }, placeCacheTtlMs);
  }

  if (isAddressLikeQuery(query) && geocoderBaseUrl) {
    const addressMatches = [];
    const addressQuery = fallbackPlaceQueries(query)[0] || query;
    const geocodedAddress = await geocodeSupportedPlace(addressQuery);
    if (geocodedAddress.ok) {
      const stopLists = await Promise.all(geocodedAddress.matches.slice(0, 3).map(match => nearbyVbnStops(match)));
      geocodedAddress.matches.slice(0, 3).forEach((match, index) => {
        addressMatches.push(markPlaceSource({
          ...match,
          type: "place",
          nearbyStops: stopLists[index] || []
        }, "address_geocoder"));
      });
    }
    const addressChoices = rankedChoicesFromPlaces(addressMatches, query, "address_geocoder");
    if (addressChoices.length) {
      const selection = addressChoices[0].locationSelection;
      const place = selectedPlaceFromPayload(selection);
      return cacheSet(placeCache, key, {
        ok: true,
        source: "address_geocoder",
        aliasUsed: false,
        place,
        choices: addressChoices
      }, placeCacheTtlMs);
    }
  }

  const directOldenburgKnown = !/\b(oldenburg|bremen)\b/i.test(query)
    ? resolveKnownPlace(`${query} Oldenburg`, { exactOnly: true })
    : null;
  if (directOldenburgKnown) {
    const stops = await nearbyVbnStops(directOldenburgKnown);
    return cacheSet(placeCache, key, {
      ok: true,
      source: "known_place_oldenburg",
      place: resolvedPlaceFromKnown(directOldenburgKnown, "known_place_oldenburg", stops)
    }, placeCacheTtlMs);
  }

  for (const aliasQuery of aliasQueries.slice(0, 1)) {
    const geocodedAlias = await geocodeSupportedPlace(aliasQuery);
    if (geocodedAlias.ok && geocodedAlias.matches?.length) {
      const matches = [];
      for (const match of geocodedAlias.matches.slice(0, 4)) {
        matches.push(markPlaceSource({
          ...match,
          nearbyStops: await nearbyVbnStops(match)
        }, "alias_geocoder"));
      }
      const aliasGeocoderChoices = rankedChoicesFromPlaces(matches, query, "alias_geocoder");
      if (aliasGeocoderChoices.length > 1 && options.allowAmbiguous) {
        return cacheSet(placeCache, key, {
          ok: false,
          error: "ambiguous_supported_place",
          aliasUsed: true,
          aliasQueries,
          choices: aliasGeocoderChoices.slice(0, 5)
        }, placeCacheTtlMs);
      }
      return cacheSet(placeCache, key, {
        ok: true,
        source: "alias_geocoder",
        aliasUsed: true,
        aliasQueries,
        place: matches[0],
        choices: aliasGeocoderChoices
      }, placeCacheTtlMs);
    }
  }

  if (await isOutsideSupportedSettlement(query)) {
    return cacheSet(placeCache, key, { ok: false, error: "outside_supported_area", aliasUsed: aliasQueries.length > 0, choices: [] }, placeCacheTtlMs);
  }

  const stopQueries = [query, ...aliasQueries];
  let stopMatches = [];
  let stopAliasUsed = false;
  for (const stopQuery of stopQueries) {
    stopMatches = await searchVbnStopsByName(stopQuery);
    stopAliasUsed = stopQuery !== query;
    if (stopMatches.length) break;
  }

  if (stopMatches.length === 1 || (stopMatches[0] && normalizeText(stopMatches[0].name) === normalizeText(query))) {
    return cacheSet(placeCache, key, {
      ok: true,
      source: stopAliasUsed ? "alias_vbn_stop" : "vbn_stop",
      aliasUsed: stopAliasUsed,
      place: {
        ...stopMatches[0],
        source: stopAliasUsed ? "alias_vbn_stop" : "vbn_stop",
        nearbyStops: stopMatches
      }
    }, placeCacheTtlMs);
  }

  const fuzzyKnown = resolveKnownPlace(query);
  if (fuzzyKnown) {
    const stops = await nearbyVbnStops(fuzzyKnown);
    return cacheSet(placeCache, key, {
      ok: true,
      source: "known_place",
      place: resolvedPlaceFromKnown(fuzzyKnown, "known_place", stops)
    }, placeCacheTtlMs);
  }

  if (stopMatches.length > 1 && options.allowAmbiguous) {
    const choices = stopMatches.map(stop => locationChoice({
      ...stop,
      source: stopAliasUsed ? "alias_vbn_stop" : "vbn_stop",
      nearbyStops: [stop]
    })).filter(Boolean);
    const fuzzyKnownChoice = resolveKnownPlace(query);
    if (fuzzyKnownChoice && !choices.some(choice => normalizeText(choice.value) === normalizeText(fuzzyKnownChoice.name))) {
      const area = areaForCoords(fuzzyKnownChoice.lat, fuzzyKnownChoice.lon);
      const knownChoice = locationChoice({
        ...fuzzyKnownChoice,
        area: area ? area.name : "",
        source: "known_place"
      });
      if (knownChoice) choices.unshift(knownChoice);
    }

    return cacheSet(placeCache, key, {
      ok: false,
      error: "ambiguous_supported_place",
      aliasUsed: stopAliasUsed,
      choices: choices.slice(0, 4)
    }, placeCacheTtlMs);
  }

  const geocoderQueries = aliasQueries.length ? [] : [fallbackPlaceQueries(query)[0] || query];
  const geocoderMatches = [];
  let geocoderError = "";
  for (const geocoderQuery of geocoderQueries.length ? geocoderQueries : [query]) {
    const geocoded = await geocodeSupportedPlace(geocoderQuery);
    if (!geocoded.ok) {
      geocoderError = geocoded.error || geocoderError;
      continue;
    }
    for (const match of geocoded.matches.slice(0, 4)) {
      geocoderMatches.push(markPlaceSource({
        ...match,
        nearbyStops: await nearbyVbnStops(match)
      }, "geocoder"));
    }
  }

  if (!geocoderMatches.length) return cacheSet(placeCache, key, { ok: false, error: geocoderError || "unknown_supported_place", aliasUsed: aliasQueries.length > 0, choices: [] }, placeCacheTtlMs);

  const matches = uniquePlaces(geocoderMatches)
    .map(place => ({ ...place, score: scorePlaceMatch(place, query) }))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.importance || 0) - (a.importance || 0));

  if (!matches.length) return cacheSet(placeCache, key, { ok: false, error: "unknown_supported_place", aliasUsed: aliasQueries.length > 0, choices: [] }, placeCacheTtlMs);

  const first = matches[0];
  const second = matches[1];
  const rankedChoices = matches.map(match => locationChoice(match)).filter(Boolean);
  const shouldAsk = options.allowAmbiguous
    && second
    && normalizeText(first.name) !== normalizeText(second.name)
    && ((first.score || 0) < 0.85 || Math.abs((first.score || 0) - (second.score || 0)) < 0.2);

  if (shouldAsk) {
    return cacheSet(placeCache, key, {
      ok: false,
      error: "ambiguous_supported_place",
      aliasUsed: aliasQueries.length > 0,
      choices: rankedChoices.slice(0, 5)
    }, placeCacheTtlMs);
  }

  return cacheSet(placeCache, key, {
    ok: true,
    source: "geocoder",
    aliasUsed: aliasQueries.length > 0,
    place: first,
    choices: rankedChoices
  }, placeCacheTtlMs);
}

// All route times are interpreted in Oldenburg/Bremen local time, regardless
// of the timezone the Node process happens to run in.
const ROUTE_TIMEZONE = "Europe/Berlin";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function zonedDateParts(date, timeZone = ROUTE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = Number(part.value);
    return acc;
  }, {});
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

function timeZoneOffsetMs(utcMs, timeZone) {
  const parts = zonedDateParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

function zonedWallClockToUtcMs(parts, timeZone = ROUTE_TIMEZONE) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return guess - timeZoneOffsetMs(guess, timeZone);
}

function addDaysToDateParts(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function formatDateForOtp(date) {
  const parts = zonedDateParts(date, ROUTE_TIMEZONE);
  return `${pad2(parts.month)}-${pad2(parts.day)}-${parts.year}`;
}

// Parses a time expression (e.g. "12pm", "tomorrow 9:00", "now") into the
// OTP date/time strings, always relative to the current Europe/Berlin time.
function parseRouteTime(value, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const nowParts = zonedDateParts(now, ROUTE_TIMEZONE);
  const raw = String(value || "").trim().toLowerCase();

  const wantsTomorrow = /\b(tomorrow|tomorow|tommorow|morgen)\b/i.test(raw);
  const wantsToday = !wantsTomorrow && /\btoday\b/i.test(raw);
  const explicitDate = wantsTomorrow ? "tomorrow" : (wantsToday ? "today" : "");
  const dateParts = wantsTomorrow ? addDaysToDateParts(nowParts, 1) : { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  const otpDate = `${pad2(dateParts.month)}-${pad2(dateParts.day)}-${dateParts.year}`;
  const nowTime = `${pad2(nowParts.hour)}:${pad2(nowParts.minute)}:${pad2(nowParts.second)}`;

  if (!raw || raw === "now" || raw === "jetzt") {
    return { date: otpDate, time: nowTime, hour: nowParts.hour, minute: nowParts.minute, isNow: true, explicitDate };
  }

  const match = raw.match(/([0-2]?\d)(?::([0-5]\d))?\s*(am|pm)?/);
  if (!match) {
    return { date: otpDate, time: nowTime, hour: nowParts.hour, minute: nowParts.minute, isNow: true, explicitDate };
  }

  let hour = Math.min(Number(match[1]), 23);
  if (match[3] === "pm" && hour < 12) hour += 12;
  if (match[3] === "am" && hour === 12) hour = 0;
  const minute = Number(match[2] || "0");
  return {
    date: otpDate,
    time: `${pad2(hour)}:${pad2(minute)}:00`,
    hour,
    minute,
    isNow: false,
    explicitDate
  };
}

function datedRouteTimeText(timeText, explicitDate = "") {
  const raw = String(timeText || "").trim();
  const canonicalExplicitDate = explicitDate || detectExplicitDate(raw);
  if (!canonicalExplicitDate || detectExplicitDate(raw) || !raw) return raw;
  return `${canonicalExplicitDate} ${raw}`;
}

// Decides whether a requested route time is in the past and needs
// clarification before a route is planned. "now" and explicit "tomorrow"
// requests are never treated as past.
function resolveRequestedDateTime(timeText, now = new Date()) {
  const tripTime = parseRouteTime(timeText, { now });

  if (tripTime.isNow || tripTime.explicitDate === "tomorrow") {
    return { status: "ok", tripTime, mode: tripTime.isNow ? "now" : "scheduled" };
  }

  const requestedMs = otpDateTimeMs(tripTime.date, tripTime.time);
  const diffMs = now.getTime() - requestedMs;
  const pastTimeGraceMs = 2 * 60000;

  if (diffMs > pastTimeGraceMs) {
    return { status: "past_time", tripTime, requestedMs, nowMs: now.getTime() };
  }

  if (diffMs > 0) {
    return { status: "ok", tripTime: parseRouteTime("now", { now }), mode: "now" };
  }

  return { status: "ok", tripTime, mode: "scheduled" };
}

function validateRequestedTime({ requestedDateTime, explicitDate = "", timeMode, selectedLanguage, now = new Date() }) {
  const raw = String(requestedDateTime || "").trim();
  const explicitPastDate = /\b(yesterday|gestern|dün|вчора)\b/i.test(raw)
    || /(?:أمس|बीता\s+कल)/.test(raw);
  if (explicitPastDate) {
    console.log("[PAST TIME VALIDATION DEBUG]", {
      requestedDateTime: raw,
      explicitDate: "yesterday",
      now,
      isPastTime: true,
      timeMode: normalizeTimeMode(timeMode)
    });
    return { status: "past_time", invalidPastDate: true, requestedDateTime: raw, timeMode: normalizeTimeMode(timeMode), selectedLanguage };
  }

  const canonicalExplicitDate = explicitDate || detectExplicitDate(raw);
  const datedRequest = canonicalExplicitDate && !detectExplicitDate(raw)
    ? `${canonicalExplicitDate} ${raw}`
    : raw;
  const resolution = resolveRequestedDateTime(datedRequest, now);
  const resolvedRequestedMs = resolution.tripTime
    ? otpDateTimeMs(resolution.tripTime.date, resolution.tripTime.time)
    : null;
  const debugPayload = {
    requestedDateTime: resolvedRequestedMs ? new Date(resolvedRequestedMs).toISOString() : raw,
    explicitDate: canonicalExplicitDate,
    now,
    isPastTime: resolution.status === "past_time",
    timeMode: normalizeTimeMode(timeMode)
  };
  console.log("[PAST TIME VALIDATION DEBUG]", debugPayload);
  if (resolution.status !== "past_time") return { status: "ok", explicitDate: canonicalExplicitDate };

  const tomorrowParts = addDaysToDateParts(zonedDateParts(now, ROUTE_TIMEZONE), 1);
  return {
    status: "past_time",
    requestedDateTime: raw,
    explicitDate: canonicalExplicitDate,
    requestedMs: resolution.requestedMs,
    hour: resolution.tripTime.hour,
    minute: resolution.tripTime.minute,
    timeMode: normalizeTimeMode(timeMode),
    selectedLanguage,
    suggestedNow: now.toISOString(),
    suggestedTomorrow: new Date(zonedWallClockToUtcMs({
      ...tomorrowParts,
      hour: resolution.tripTime.hour,
      minute: resolution.tripTime.minute,
      second: 0
    }, ROUTE_TIMEZONE)).toISOString()
  };
}

function authHeaderValue() {
  if (!vbnAuthScheme) return vbnApiKey;
  if (/^bearer\s/i.test(vbnApiKey)) return vbnApiKey;
  return `${vbnAuthScheme} ${vbnApiKey}`;
}

function delayText(seconds, lang = "en") {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return null;
  if (seconds === 0) return { de: "pünktlich", ar: "في الوقت", tr: "zamanında", uk: "вчасно", hi: "समय पर", en: "on time" }[lang] || "on time";
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (seconds > 0) return {
    de: `${minutes} Min. verspätet`,
    ar: `متأخر ${minutes} دقيقة`,
    tr: `${minutes} dk gecikmeli`,
    uk: `запізнення ${minutes} хв`,
    hi: `${minutes} मिनट देर`,
    en: `${minutes} min late`
  }[lang] || `${minutes} min late`;
  return {
    de: `${minutes} Min. früher`,
    ar: `مبكر ${minutes} دقيقة`,
    tr: `${minutes} dk erken`,
    uk: `${minutes} хв раніше`,
    hi: `${minutes} मिनट पहले`,
    en: `${minutes} min early`
  }[lang] || `${minutes} min early`;
}

function wheelchairValue(place) {
  const value = place && (place.wheelchairBoarding ?? place.wheelchair_boarding);
  if (value === 1 || value === "POSSIBLE" || value === "YES") return "possible";
  if (value === 2 || value === "NOT_POSSIBLE" || value === "NO") return "not possible";
  return "unknown";
}

function getLatLon(point) {
  if (!point) return null;

  const lat = point.lat
    ?? point.latitude
    ?? point.vertex?.lat
    ?? point.stop?.lat
    ?? point.coordinate?.lat
    ?? point.coords?.lat;

  const lon = point.lon
    ?? point.lng
    ?? point.longitude
    ?? point.vertex?.lon
    ?? point.vertex?.lng
    ?? point.stop?.lon
    ?? point.stop?.lng
    ?? point.coordinate?.lon
    ?? point.coordinate?.lng
    ?? point.coords?.lon
    ?? point.coords?.lng;

  if (lat == null || lon == null) return null;

  const normalized = {
    lat: Number(lat),
    lon: Number(lon)
  };

  return Number.isFinite(normalized.lat) && Number.isFinite(normalized.lon)
    ? normalized
    : null;
}

function buildWalkingMapsUrlFromCoords(from, to) {
  const origin = getLatLon(from);
  const destination = getLatLon(to);
  if (!origin || !destination) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}&travelmode=walking`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  return distanceMeters(
    { lat: Number(lat1), lon: Number(lon1) },
    { lat: Number(lat2), lon: Number(lon2) }
  );
}

function assertFirstWalkUsesResolvedOrigin(resolvedOrigin, firstWalkLeg) {
  if (!resolvedOrigin || !firstWalkLeg) return;

  const fromLat = firstWalkLeg?.fromCoords?.lat ?? firstWalkLeg?.from?.lat;
  const fromLon = firstWalkLeg?.fromCoords?.lon ?? firstWalkLeg?.from?.lon;

  const latMatches = Math.abs(Number(fromLat) - Number(resolvedOrigin.lat)) < 0.0001;
  const lonMatches = Math.abs(Number(fromLon) - Number(resolvedOrigin.lon)) < 0.0001;

  if (!latMatches || !lonMatches) {
    console.error("[BUG: FIRST WALK DOES NOT USE RESOLVED ORIGIN]", {
      resolvedOrigin,
      firstWalkLeg,
      fromLat,
      fromLon
    });
  }
}

function logRouteCoordinateDebug({ rawText = "", details = {}, resolvedOrigin = null, resolvedDestination = null, route = null }) {
  const firstWalkLeg = route?.legs?.find(leg => leg.mode === "WALK") || null;
  const firstWalkFrom = getLatLon(firstWalkLeg?.fromCoords) || getLatLon(firstWalkLeg?.from);

  console.log("[ROUTE REQUEST DEBUG]", {
    rawText,
    originText: details.start || "",
    destinationText: details.destination || "",
    requestedDateTime: details.time || "",
    timeMode: normalizeTimeMode(details.timeMode)
  });

  console.log("[RESOLVED PLACES DEBUG]", {
    originText: details.start || "",
    originLabel: resolvedOrigin?.label || resolvedOrigin?.name,
    originLat: resolvedOrigin?.lat,
    originLon: resolvedOrigin?.lon,
    destinationText: details.destination || "",
    destinationLabel: resolvedDestination?.label || resolvedDestination?.name,
    destinationLat: resolvedDestination?.lat,
    destinationLon: resolvedDestination?.lon
  });

  console.log("[FIRST WALK LEG DEBUG]", {
    fromName: firstWalkLeg?.from?.label || firstWalkLeg?.from?.name,
    fromLat: firstWalkLeg?.fromCoords?.lat || firstWalkLeg?.from?.lat,
    fromLon: firstWalkLeg?.fromCoords?.lon || firstWalkLeg?.from?.lon,
    toName: firstWalkLeg?.to?.label || firstWalkLeg?.to?.name,
    toLat: firstWalkLeg?.toCoords?.lat || firstWalkLeg?.to?.lat,
    toLon: firstWalkLeg?.toCoords?.lon || firstWalkLeg?.to?.lon,
    mapsUrl: firstWalkLeg?.mapsUrl
  });

  console.log("[ALL WALK LEGS DEBUG]", (route?.legs || [])
    .filter(leg => leg.mode === "WALK")
    .map((leg, index) => ({
      index,
      from: leg.from,
      to: leg.to,
      fromCoords: leg.fromCoords,
      toCoords: leg.toCoords,
      mapsUrl: leg.mapsUrl
    }))
  );

  assertFirstWalkUsesResolvedOrigin(resolvedOrigin, firstWalkLeg);

  if (resolvedOrigin && firstWalkFrom) {
    const distanceFromResolvedOrigin = haversineMeters(
      resolvedOrigin.lat,
      resolvedOrigin.lon,
      firstWalkFrom.lat,
      firstWalkFrom.lon
    );

    if (distanceFromResolvedOrigin > 80) {
      console.error("[BUG: FIRST WALK START TOO FAR FROM REQUESTED ORIGIN]", {
        distanceFromResolvedOrigin,
        resolvedOrigin,
        firstWalkLeg
      });
    }
  }

  return { firstWalkLeg };
}

function normalizeLegPlace(place, coords) {
  if (!place) return null;

  return {
    name: place.name,
    stopId: place.stopId || "",
    wheelchairBoarding: wheelchairValue(place),
    ...(coords ? coords : {})
  };
}

function routeEndpointPlace(endpoint, fallbackName = "") {
  if (!endpoint) return null;
  const coords = getLatLon(endpoint);
  const name = endpoint.name || endpoint.label || endpoint.text || fallbackName;
  return {
    name,
    stopId: endpoint.stopId || "",
    wheelchairBoarding: wheelchairValue(endpoint),
    ...(coords ? coords : {})
  };
}

function rawCoordinateFields(point) {
  if (!point) return null;

  return {
    lat: point.lat,
    lon: point.lon,
    lng: point.lng,
    latitude: point.latitude,
    longitude: point.longitude,
    vertex: point.vertex ? {
      lat: point.vertex.lat,
      lon: point.vertex.lon,
      lng: point.vertex.lng
    } : null,
    stop: point.stop ? {
      lat: point.stop.lat,
      lon: point.stop.lon,
      lng: point.stop.lng
    } : null,
    coordinate: point.coordinate ? {
      lat: point.coordinate.lat,
      lon: point.coordinate.lon,
      lng: point.coordinate.lng
    } : null,
    coords: point.coords ? {
      lat: point.coords.lat,
      lon: point.coords.lon,
      lng: point.coords.lng
    } : null
  };
}

function routeResolvedEndpoint(rawText, place) {
  if (!place) return null;
  return {
    rawText: rawText || "",
    name: place.name || "",
    label: place.name || "",
    stopId: place.stopId || "",
    lat: Number(place.lat),
    lon: Number(place.lon),
    source: place.source || "",
    type: place.type || "",
    area: place.area || "",
    nearbyStops: Array.isArray(place.nearbyStops) ? place.nearbyStops : []
  };
}

function normalizePlaceName(value) {
  return normalizeText(value)
    .replace(/\boldenburg\s*oldb\b/g, "oldenburg")
    .replace(/\boldenburg\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldSuppressFinalWalk(lastTransitStop, requestedDestination, finalWalkLeg) {
  const finalWalkDistance = Number(finalWalkLeg?.distance ?? finalWalkLeg?.distanceMeters ?? 0);

  if (finalWalkDistance <= 30) return true;

  if (
    lastTransitStop?.stopId &&
    requestedDestination?.stopId &&
    lastTransitStop.stopId === requestedDestination.stopId
  ) {
    return true;
  }

  const lastStopName = normalizePlaceName(lastTransitStop?.name || lastTransitStop?.label);
  const destName = normalizePlaceName(requestedDestination?.name || requestedDestination?.label);

  if (lastStopName && destName && lastStopName === destName) {
    return true;
  }

  return false;
}

function finalWalkDebugPayload({ rawDestinationText, requestedDestination, lastTransitStop, finalWalkLeg }) {
  const finalWalkDistance = Number(finalWalkLeg?.distance ?? finalWalkLeg?.distanceMeters ?? 0);
  const stopIdsMatch = Boolean(
    lastTransitStop?.stopId &&
    requestedDestination?.stopId &&
    lastTransitStop.stopId === requestedDestination.stopId
  );
  const lastStopName = normalizePlaceName(lastTransitStop?.name || lastTransitStop?.label);
  const destName = normalizePlaceName(requestedDestination?.name || requestedDestination?.label);
  const namesMatch = Boolean(lastStopName && destName && lastStopName === destName);
  const shouldSuppressFinalWalkValue = shouldSuppressFinalWalk(lastTransitStop, requestedDestination, finalWalkLeg);

  return {
    rawDestinationText,
    requestedDestination,
    lastTransitStop,
    finalWalkLeg,
    stopIdsMatch,
    namesMatch,
    finalWalkDistance,
    shouldSuppressFinalWalk: shouldSuppressFinalWalkValue
  };
}

function fixWalkingLegEndpoints(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const transitIndexes = legs
    .map((leg, index) => ({ leg, index }))
    .filter(item => item.leg.mode !== "WALK");
  const firstTransit = transitIndexes[0];
  const lastTransit = transitIndexes[transitIndexes.length - 1];
  const requestedOrigin = route?.requestedOrigin || null;
  const requestedDestination = route?.requestedDestination || null;

  const fixedRoute = {
    ...route,
    legs: legs.map((leg, index) => {
      if (leg.mode !== "WALK") return leg;

      const previousTransit = [...transitIndexes]
        .reverse()
        .find(item => item.index < index)?.leg;
      const nextTransit = transitIndexes
        .find(item => item.index > index)?.leg;
      const from = previousTransit?.to || requestedOrigin || leg.from;
      const to = nextTransit?.from || requestedDestination || leg.to;
      const fromCoords = getLatLon(from) || getLatLon(leg.fromCoords) || getLatLon(leg.from);
      const toCoords = getLatLon(to) || getLatLon(leg.toCoords) || getLatLon(leg.to);

      return {
        ...leg,
        from,
        fromCoords,
        to,
        toCoords,
        mapsUrl: buildWalkingMapsUrlFromCoords(fromCoords, toCoords)
      };
    })
  };

  console.log("[WALK LEGS FIX DEBUG]", fixedRoute.legs.map((leg, index) => ({
    index,
    mode: leg.mode,
    from: leg.from?.label || leg.from?.name,
    to: leg.to?.label || leg.to?.name,
    fromCoords: leg.fromCoords,
    toCoords: leg.toCoords,
    mapsUrl: leg.mapsUrl
  })));
  console.log("[WALK LEG CONSISTENCY DEBUG]", {
    requestedOrigin,
    requestedDestination,
    firstTransitFrom: firstTransit?.leg?.from,
    lastTransitTo: lastTransit?.leg?.to
  });

  return fixedRoute;
}

function normalizeItinerary(itinerary, routeCoords = {}) {
  const legs = Array.isArray(itinerary.legs) ? itinerary.legs : [];
  const firstWalkIndex = legs.findIndex(leg => leg.mode === "WALK");
  const lastWalkIndex = legs.reduce((lastIndex, leg, index) => leg.mode === "WALK" ? index : lastIndex, -1);
  const requestedDestination = routeCoords.requestedDestination || routeCoords.destination;
  let normalizedLegs = legs.map((leg, index) => {
      const isWalk = leg.mode === "WALK";
      const isFirstWalk = isWalk && index === firstWalkIndex;
      const isLastWalk = isWalk && index === lastWalkIndex;
      // A walk is "genuinely last" only when no transit leg follows it.
      // WALK → BUS has isLastWalk=true for the WALK but the walk ends at the
      // boarding stop, not the final destination.
      const isGenuinelyLastWalk = isLastWalk && !legs.slice(index + 1).some(l => l.mode !== "WALK");
      const requestedOrigin = routeCoords.requestedOrigin || routeCoords.origin;
      let fromCoords = getLatLon(leg.from) || getLatLon(leg.fromCoords) || getLatLon(leg.fromCoord);
      let toCoords = getLatLon(leg.to) || getLatLon(leg.toCoords) || getLatLon(leg.toCoord);

      if (isFirstWalk) {
        fromCoords = getLatLon(requestedOrigin) || fromCoords;
      }

      if (isGenuinelyLastWalk) {
        toCoords = getLatLon(requestedDestination) || toCoords;
      }

      const mapsUrl = isWalk
        ? buildWalkingMapsUrlFromCoords(fromCoords, toCoords)
        : null;

      const fromPlace = isFirstWalk
        ? routeEndpointPlace(requestedOrigin, routeCoords.originLabel)
        : normalizeLegPlace(leg.from, fromCoords);
      const toPlace = isGenuinelyLastWalk
        ? routeEndpointPlace(requestedDestination, routeCoords.destinationLabel)
        : normalizeLegPlace(leg.to, toCoords);

      if (isWalk) {
        console.log("[Walking Leg Debug]", {
          index,
          isFirstWalk,
          isLastWalk,
          isGenuinelyLastWalk,
          fromName: fromPlace?.name || leg.from?.name || "",
          toName: toPlace?.name || leg.to?.name || "",
          fromCoords,
          toCoords,
          mapsUrl
        });
        const nextTransitLeg = legs.slice(index + 1).find(l => l.mode !== "WALK");
        console.log("[WALK LABEL DEBUG]", {
          walkLegIndex: index,
          walkFrom: fromPlace?.name || fromPlace?.label,
          walkTo: toPlace?.name || toPlace?.label,
          nextTransitFrom: nextTransitLeg?.from?.name || nextTransitLeg?.from?.stopName,
          requestedDestination: requestedDestination?.name || requestedDestination?.label
        });
        if (nextTransitLeg) {
          const walkToName = (toPlace?.name || toPlace?.label || "").trim();
          const nextFromName = (nextTransitLeg.from?.name || nextTransitLeg.from?.stopName || "").trim();
          if (walkToName && nextFromName && walkToName !== nextFromName) {
            console.warn("[ROUTE LEG LABEL MISMATCH]", {
              walkLegIndex: index,
              walkToName,
              nextTransitFromName: nextFromName
            });
          }
        }
      }

      if (isFirstWalk && mapsUrl) {
        const originCoords = getLatLon(requestedOrigin);
        const startsFromRequestedOrigin = originCoords
          && mapsUrl.includes(`origin=${originCoords.lat},${originCoords.lon}`);
        if (!startsFromRequestedOrigin) {
          console.warn("[Walking Map Bug]", {
            index,
            expectedOriginCoords: originCoords,
            actualFromCoords: fromCoords,
            mapsUrl
          });
        }
      }

      if (isWalk && !mapsUrl) {
        console.warn("[Walking Map] Missing coordinates", {
          index,
          rawCoordinateFields: {
            from: rawCoordinateFields(leg.from),
            to: rawCoordinateFields(leg.to),
            fromCoord: rawCoordinateFields(leg.fromCoord),
            toCoord: rawCoordinateFields(leg.toCoord),
            fromCoords: rawCoordinateFields(leg.fromCoords),
            toCoords: rawCoordinateFields(leg.toCoords)
          },
          normalized: { fromCoords, toCoords }
        });
      }

      return {
        mode: leg.mode,
        route: leg.routeShortName || leg.route || leg.routeLongName || "",
        routeId: leg.routeId || "",
        tripId: leg.tripId || "",
        headsign: leg.headsign || "",
        agencyName: leg.agencyName || "",
        from: fromPlace,
        to: toPlace,
        fromCoords,
        toCoords,
        mapsUrl,
        rawCoordinateFields: leg.mode === "WALK" ? {
          from: rawCoordinateFields(leg.from),
          to: rawCoordinateFields(leg.to),
          fromCoord: rawCoordinateFields(leg.fromCoord),
          toCoord: rawCoordinateFields(leg.toCoord),
          fromCoords: rawCoordinateFields(leg.fromCoords),
          toCoords: rawCoordinateFields(leg.toCoords)
        } : null,
        steps: Array.isArray(leg.steps) && leg.steps.length ? leg.steps : (Array.isArray(leg.walkSteps) && leg.walkSteps.length ? leg.walkSteps : []),
        departure: leg.startTime,
        arrival: leg.endTime,
        distanceMeters: Math.round(Number(leg.distance) || 0),
        departureDelay: leg.departureDelay ?? null,
        arrivalDelay: leg.arrivalDelay ?? null,
        departureDelayText: delayText(leg.departureDelay),
        arrivalDelayText: delayText(leg.arrivalDelay),
        realTime: Boolean(leg.realTime),
        cancelled: String(leg.scheduleRelationship || "").toUpperCase() === "CANCELED",
        scheduleRelationship: leg.scheduleRelationship || ""
      };
    });

  normalizedLegs = fixWalkingLegEndpoints({
    legs: normalizedLegs,
    requestedOrigin: routeEndpointPlace(routeCoords.requestedOrigin || routeCoords.origin, routeCoords.originLabel),
    requestedDestination: routeEndpointPlace(requestedDestination, routeCoords.destinationLabel)
  }).legs;

  const finalWalkLeg = normalizedLegs[lastWalkIndex] || null;
  const lastTransitLegBeforeFinalWalk = finalWalkLeg
    ? [...normalizedLegs.slice(0, lastWalkIndex)].reverse().find(leg => leg.mode !== "WALK")
    : null;
  const lastTransitStop = lastTransitLegBeforeFinalWalk?.to || null;
  const finalWalkDebug = finalWalkDebugPayload({
    rawDestinationText: requestedDestination?.rawText || routeCoords.destinationText || "",
    requestedDestination,
    lastTransitStop,
    finalWalkLeg
  });

  if (finalWalkLeg && lastTransitStop) {
    console.log("[FINAL WALK DEBUG]", finalWalkDebug);
  }

  const shouldSuppressFinalWalkValue = Boolean(finalWalkLeg && lastTransitStop && finalWalkDebug.shouldSuppressFinalWalk);
  const filteredLegs = shouldSuppressFinalWalkValue
    ? normalizedLegs.filter((_, index) => index !== lastWalkIndex)
    : normalizedLegs;
  const walkingDistanceMeters = filteredLegs
    .filter(leg => leg.mode === "WALK")
    .reduce((total, leg) => total + (Number(leg.distanceMeters) || 0), 0);

  return {
    durationMinutes: Math.round((Number(itinerary.duration) || 0) / 60),
    startTime: itinerary.startTime,
    endTime: shouldSuppressFinalWalkValue && lastTransitLegBeforeFinalWalk?.arrival
      ? lastTransitLegBeforeFinalWalk.arrival
      : itinerary.endTime,
    transfers: Math.max(0, filteredLegs.filter(leg => leg.mode !== "WALK").length - 1),
    walkingDistanceMeters: Math.round(walkingDistanceMeters),
    suppressedFinalWalk: shouldSuppressFinalWalkValue ? finalWalkDebug : null,
    legs: filteredLegs
  };
}

function routeModeIcon(mode) {
  if (mode === "WALK") return "🚶";
  if (mode === "BUS") return "🚌";
  if (mode === "TRAM") return "🚋";
  if (mode === "RAIL" || mode === "TRAIN") return "🚆";
  return "•";
}

function formatClock(value, lang = "en") {
  if (!value) return "";
  const localeMap = { de: "de-DE", ar: "ar-SA", tr: "tr-TR", uk: "uk-UA", hi: "hi-IN", en: "en-US" };
  const hour12 = lang !== "de" && lang !== "tr" && lang !== "uk" && lang !== "hi";
  return new Intl.DateTimeFormat(localeMap[lang] || "en-US", {
    hour: "numeric", minute: "2-digit", hour12, timeZone: "Europe/Berlin"
  }).format(new Date(value));
}

function isTransitLeg(leg) {
  return leg && leg.mode && leg.mode !== "WALK";
}

function stopNameKey(place) {
  return normalizeText(place?.name || "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

function sameStop(a, b) {
  if (!a || !b) return false;
  if (a.stopId && b.stopId && a.stopId === b.stopId) return true;
  const aName = stopNameKey(a);
  const bName = stopNameKey(b);
  if (aName && bName && aName === bName) return true;

  const aCoords = getLatLon(a);
  const bCoords = getLatLon(b);
  if (!aCoords || !bCoords) return false;
  const latMeters = (aCoords.lat - bCoords.lat) * 111320;
  const lonMeters = (aCoords.lon - bCoords.lon) * 111320 * Math.cos(((aCoords.lat + bCoords.lat) / 2) * Math.PI / 180);
  return Math.sqrt(latMeters * latMeters + lonMeters * lonMeters) <= 180;
}

function sameTransitSegment(a, b) {
  return isTransitLeg(a)
    && isTransitLeg(b)
    && sameStop(a.from, b.from)
    && sameStop(a.to, b.to);
}

function inSegmentTimeWindow(candidate, mainLeg) {
  const departure = Number(candidate?.departure);
  const mainDeparture = Number(mainLeg?.departure);
  if (!Number.isFinite(departure) || !Number.isFinite(mainDeparture)) return true;
  const diffMinutes = (departure - mainDeparture) / 60000;
  return diffMinutes >= -30 && diffMinutes <= 60;
}

function segmentAlternativeFromLeg(leg) {
  return {
    mode: leg.mode,
    route: leg.route || "",
    routeId: leg.routeId || "",
    tripId: leg.tripId || "",
    headsign: leg.headsign || "",
    departure: leg.departure,
    arrival: leg.arrival,
    departureDelay: leg.departureDelay ?? null,
    arrivalDelay: leg.arrivalDelay ?? null,
    realTime: Boolean(leg.realTime),
    from: leg.from ? {
      name: leg.from.name || "",
      stopId: leg.from.stopId || "",
      lat: leg.from.lat,
      lon: leg.from.lon
    } : null,
    to: leg.to ? {
      name: leg.to.name || "",
      stopId: leg.to.stopId || "",
      lat: leg.to.lat,
      lon: leg.to.lon
    } : null
  };
}

function dedupeSegmentAlternatives(alternatives, mainLeg) {
  const seen = new Set();
  return (alternatives || [])
    .filter(alt => alt && alt.route && alt.route !== mainLeg.route)
    .sort((a, b) => (Number(a.departure) || 0) - (Number(b.departure) || 0))
    .filter(alt => {
      const key = [
        alt.mode || "",
        alt.route || "",
        alt.from?.stopId || stopNameKey(alt.from),
        alt.to?.stopId || stopNameKey(alt.to)
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function extractSegmentAlternativesFromItineraries(mainLeg, itineraries) {
  const candidates = [];
  (itineraries || []).forEach(itinerary => {
    (itinerary.legs || []).forEach(leg => {
      if (!sameTransitSegment(mainLeg, leg) || !inSegmentTimeWindow(leg, mainLeg)) return;
      candidates.push(segmentAlternativeFromLeg(leg));
    });
  });
  return dedupeSegmentAlternatives(candidates, mainLeg);
}

async function fetchSegmentAlternativesForLeg(mainLeg) {
  const from = getLatLon(mainLeg?.from) || getLatLon(mainLeg?.fromCoords);
  const to = getLatLon(mainLeg?.to) || getLatLon(mainLeg?.toCoords);
  const departure = Number(mainLeg?.departure);
  if (!from || !to || !Number.isFinite(departure)) return [];

  const routeCoords = {
    origin: { lat: from.lat, lon: from.lon },
    destination: { lat: to.lat, lon: to.lon }
  };
  const allAlternatives = [];
  const queryOffsetsMinutes = [-30, 0, 20, 40];

  for (const offset of queryOffsetsMinutes) {
    const queryTime = new Date(departure + offset * 60000);
    const url = new URL(`${vbnApiBase.replace(/\/$/, "")}/routers/${vbnRouterId}/plan`);
    url.search = new URLSearchParams({
      arriveBy: "false",
      date: formatDateForOtp(queryTime),
      fromPlace: `${from.lat},${from.lon}`,
      toPlace: `${to.lat},${to.lon}`,
      time: formatTimeForOtp(queryTime),
      mode: "WALK,TRANSIT",
      maxWalkDistance: "900",
      numItineraries: "12"
    }).toString();

    try {
      const { response, data } = await fetchJsonWithTimeout(url, {
        headers: {
          Authorization: authHeaderValue(),
          Accept: "application/json"
        }
      }, segmentAlternativesTimeoutMs);
      if (!response.ok) continue;

      const segmentItineraries = data.plan && Array.isArray(data.plan.itineraries)
        ? data.plan.itineraries.map(itinerary => normalizeItinerary(itinerary, routeCoords))
        : [];
      allAlternatives.push(...extractSegmentAlternativesFromItineraries(mainLeg, segmentItineraries));
      if (dedupeSegmentAlternatives(allAlternatives, mainLeg).length >= 5) break;
    } catch (error) {
      console.warn("[Segment alternatives] stop-to-stop lookup failed:", error.message);
    }
  }

  return dedupeSegmentAlternatives(allAlternatives, mainLeg);
}

async function enrichSegmentAlternatives(itineraries) {
  for (const itinerary of itineraries || []) {
    for (const leg of itinerary.legs || []) {
      if (!isTransitLeg(leg)) continue;
      const fromItineraries = extractSegmentAlternativesFromItineraries(leg, itineraries);
      const fetched = fromItineraries.length >= 3
        ? []
        : await fetchSegmentAlternativesForLeg(leg);
      leg.segmentAlternatives = dedupeSegmentAlternatives([
        ...fromItineraries,
        ...fetched
      ], leg);
    }
  }
  return itineraries;
}

function otpDateTimeMs(dateText, timeText) {
  const match = String(dateText || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  const time = String(timeText || "00:00:00").split(":").map(Number);
  return zonedWallClockToUtcMs({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: time[0] || 0,
    minute: time[1] || 0,
    second: time[2] || 0
  }, ROUTE_TIMEZONE);
}

function itinerarySatisfiesTimeMode(itinerary, requestedDateTimeMs, timeMode) {
  if (normalizeTimeMode(timeMode) !== TIME_MODE.ARRIVE_BY) return true;
  return Number.isFinite(Number(itinerary?.endTime))
    && Number(itinerary.endTime) <= Number(requestedDateTimeMs);
}

function formatTimeForOtp(date) {
  const parts = zonedDateParts(date, ROUTE_TIMEZONE);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function messageMentionsArrivalDeadline(message) {
  return inferTimeModeFromText(message) === TIME_MODE.ARRIVE_BY
    || /\b(train|zug|event|meeting|appointment|termin|plane|flight|bus leaves|departure|departs|abfahrt|veranstaltung)\b/i.test(message);
}

function arriveByForRoute(route, message = "") {
  return normalizeTimeMode(route?.timeMode) === TIME_MODE.ARRIVE_BY
    || messageMentionsArrivalDeadline(message);
}

function shouldPreferTransit(message, options = {}) {
  return options.userRequestedTransit === true
    || detectTransitIntent(message, options.selectedLanguage).requested;
}

function bestItinerary(itineraries) {
  return [...(itineraries || [])].sort((a, b) => {
    const cancelledA = a.legs.some(leg => leg.cancelled) ? 1 : 0;
    const cancelledB = b.legs.some(leg => leg.cancelled) ? 1 : 0;
    const delayA = a.legs.reduce((total, leg) => total + Math.max(0, Number(leg.arrivalDelay) || 0), 0);
    const delayB = b.legs.reduce((total, leg) => total + Math.max(0, Number(leg.arrivalDelay) || 0), 0);

    return (a.transfers || 0) - (b.transfers || 0)
      || cancelledA - cancelledB
      || Number(a.endTime || 0) - Number(b.endTime || 0)
      || (a.walkingDistanceMeters || 0) - (b.walkingDistanceMeters || 0)
      || delayA - delayB
      || (a.durationMinutes || 0) - (b.durationMinutes || 0);
  })[0] || null;
}

function routeSelectionReason(selected) {
  if (!selected) return "";
  if (selected.transfers === 0) return "I selected it because it is the simplest suitable option with no transfers.";
  return `I selected it because it is the best balance of travel time and ${selected.transfers} transfer${selected.transfers === 1 ? "" : "s"}.`;
}

function legPlaceName(place, fallback) {
  const name = place?.name || "";
  if (!name || name === "Origin") return fallback;
  if (name === "Destination") return "your destination";
  return name;
}

function walkingInstruction(leg, routeResult) {
  const from = legPlaceName(leg.from, routeResult.query.start);
  const to = legPlaceName(leg.to, routeResult.query.destination);
  const meters = leg.distanceMeters ? ` about ${leg.distanceMeters} m` : "";
  return `${routeModeIcon("WALK")} Walk${meters} from ${from} to ${to}. Look for the stop sign with this stop name.`;
}

function transitInstruction(leg, lang) {
  const icon = routeModeIcon(leg.mode);
  const mode = leg.mode === "TRAM" ? "Tram" : leg.mode === "BUS" ? "Bus" : leg.mode === "RAIL" || leg.mode === "TRAIN" ? "Train" : leg.mode;
  const route = leg.route ? ` ${leg.route}` : "";
  const from = legPlaceName(leg.from, "the stop");
  const to = legPlaceName(leg.to, "the next stop");
  const departure = formatClock(leg.departure, lang);
  const arrival = formatClock(leg.arrival, lang);
  const headsign = leg.headsign ? ` toward ${leg.headsign}` : "";
  return `${icon} Take ${mode}${route}${headsign} from ${from} at ${departure}. Check the direction on the vehicle display. Get off at ${to} at ${arrival}.`;
}

function significantAlternative(selected, itineraries) {
  const selectedTransit = selected.legs.find(leg => leg.mode !== "WALK");
  return (itineraries || []).find(item => {
    if (item === selected) return false;
    const transit = item.legs.find(leg => leg.mode !== "WALK");
    return transit
      && selectedTransit
      && (transit.route !== selectedTransit.route || item.transfers !== selected.transfers)
      && Math.abs((item.durationMinutes || 0) - (selected.durationMinutes || 0)) >= 8;
  });
}

function transitModeName(mode) {
  if (mode === "TRAM") return "Tram";
  if (mode === "BUS") return "Bus";
  if (mode === "RAIL" || mode === "TRAIN") return "Train";
  return mode || "Transit";
}

function walkingMinutes(itinerary) {
  return Math.max(1, Math.round((itinerary.walkingDistanceMeters || 0) / 80));
}

function legWalkingMinutes(leg) {
  const start = Number(leg.departure);
  const end = Number(leg.arrival);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.max(1, Math.round((end - start) / 60000));
  }
  return Math.max(1, Math.round((leg.distanceMeters || 0) / 80));
}

function distanceText(meters, lang = "en") {
  const value = Math.round(Number(meters) || 0);
  if (!value) return "";
  const around = { de: "ca.", ar: "حوالي", tr: "yaklaşık", uk: "прибл.", hi: "लगभग", en: "around" }[lang] || "around";
  if (value >= 1000) return `, ${around} ${(value / 1000).toFixed(1)} km`;
  return `, ${around} ${value} m`;
}

function itineraryDisruptionText(itinerary, lang = "en") {
  const cancelled = itinerary.legs.find(leg => leg.cancelled);
  if (cancelled) {
    const messages = {
      de: `⚠️ ${transitModeName(cancelled.mode)} ${cancelled.route || ""} kann ausfallen. Prüfen Sie die Verbindung vor dem Einsteigen.`,
      ar: `⚠️ قد يتم إلغاء ${transitModeName(cancelled.mode)} ${cancelled.route || ""}. تحقق قبل الصعود.`,
      tr: `⚠️ ${transitModeName(cancelled.mode)} ${cancelled.route || ""} iptal edilmiş olabilir. Binmeden önce kontrol edin.`,
      uk: `⚠️ ${transitModeName(cancelled.mode)} ${cancelled.route || ""} може бути скасовано. Перевірте перед посадкою.`,
      hi: `⚠️ ${transitModeName(cancelled.mode)} ${cancelled.route || ""} रद्द हो सकता है। चढ़ने से पहले जाँचें।`,
      en: `⚠️ ${transitModeName(cancelled.mode)} ${cancelled.route || ""} may be cancelled. Check before boarding.`
    };
    return messages[lang] || messages.en;
  }

  const delayed = itinerary.legs.find(leg => Number(leg.arrivalDelay) > 0 || Number(leg.departureDelay) > 0);
  if (!delayed) return "";

  const delay = delayText(Number(delayed.arrivalDelay) || Number(delayed.departureDelay), lang);
  if (!delay) return "";
  const messages = {
    de: `⚠️ ${transitModeName(delayed.mode)} ${delayed.route || ""} hat ${delay}.`,
    ar: `⚠️ ${transitModeName(delayed.mode)} ${delayed.route || ""}: ${delay}.`,
    tr: `⚠️ ${transitModeName(delayed.mode)} ${delayed.route || ""}: ${delay}.`,
    uk: `⚠️ ${transitModeName(delayed.mode)} ${delayed.route || ""}: ${delay}.`,
    hi: `⚠️ ${transitModeName(delayed.mode)} ${delayed.route || ""}: ${delay}.`,
    en: `⚠️ ${transitModeName(delayed.mode)} ${delayed.route || ""} is ${delay}.`
  };
  return messages[lang] || messages.en;
}

function firstTransitLeg(itinerary) {
  return itinerary.legs.find(leg => leg.mode !== "WALK") || null;
}

function lastTransitLeg(itinerary) {
  return [...itinerary.legs].reverse().find(leg => leg.mode !== "WALK") || null;
}

function formatAlternativeLine(itinerary, lang) {
  const leg = firstTransitLeg(itinerary);
  const route = leg ? `${transitModeName(leg.mode)} ${leg.route || ""}`.trim() : ts("walkRoute", lang);
  const arrives = { de: "Ankunft", ar: "الوصول", tr: "Varış", uk: "Прибуття", hi: "पहुँचना", en: "arrives" }[lang] || "arrives";
  return `• ${route} — ${arrives} ${formatClock(itinerary.endTime, lang)}`;
}

function transferLabel(transfers, lang = "en") {
  return transferCountStr(Number(transfers) || 0, lang);
}

function formatAlternativeButtonLabel(itinerary, lang) {
  const leg = firstTransitLeg(itinerary);
  const route = leg ? `${transitModeName(leg.mode)} ${leg.route || ""}`.trim() : ts("walkRoute", lang);
  const walking = itinerary.walkingDistanceMeters
    ? ` · ${minWalkStr(walkingMinutes(itinerary), lang)}`
    : "";
  return [
    route,
    `${formatClock(itinerary.startTime, lang)} -> ${formatClock(itinerary.endTime, lang)}`,
    transferLabel(itinerary.transfers, lang)
  ].join(" · ") + walking;
}

function alternativeRouteButtons(routeResult, lang) {
  const selected = bestItinerary(routeResult?.itineraries || []);
  return (routeResult?.itineraries || [])
    .map((itinerary, index) => ({ itinerary, index }))
    .filter(item => item.itinerary !== selected)
    .slice(0, 2)
    .map(({ itinerary, index }) => ({
      label: formatAlternativeButtonLabel(itinerary, lang),
      value: `alternative_route_${index}`,
      type: "alternative_route",
      itineraryIndex: index
    }));
}

function shortRouteTicketNote(lang, isStudent = false) {
  const intro = {
    de: "Ticketinformationen",
    ar: "معلومات التذاكر",
    tr: "Bilet bilgisi",
    uk: "Інформація про квитки",
    hi: "टिकट जानकारी",
    en: "Ticket information"
  };
  const notes = {
    de: [
      "🎫 Ticket kaufen\nNutze den offiziellen VBN-Ticketservice.",
      "ℹ️ Ticketinformationen\nPrüfe Ticketarten, Preise, Gültigkeit und Informationen zu Studierendentickets."
    ],
    ar: [
      "🎫 شراء تذكرة\nاستخدم خدمة تذاكر VBN الرسمية.",
      "ℹ️ معلومات التذاكر\nتحقق من أنواع التذاكر والأسعار والصلاحية ومعلومات تذاكر الطلاب."
    ],
    tr: [
      "🎫 Bilet satın al\nResmi VBN bilet hizmetini kullan.",
      "ℹ️ Bilet bilgisi\nBilet türlerini, ücretleri, geçerliliği ve öğrenci bileti bilgilerini kontrol et."
    ],
    uk: [
      "🎫 Купити квиток\nСкористайтеся офіційним сервісом квитків VBN.",
      "ℹ️ Інформація про квитки\nПеревірте типи квитків, тарифи, чинність і студентські квитки."
    ],
    hi: [
      "🎫 टिकट खरीदें\nआधिकारिक VBN टिकट सेवा का उपयोग करें.",
      "ℹ️ टिकट जानकारी\nटिकट के प्रकार, किराया, वैधता और छात्र टिकट की जानकारी जांचें."
    ],
    en: [
      "🎫 Buy ticket\nUse the official VBN ticket service.",
      "ℹ️ Ticket Information\nCheck ticket types, fares, validity, and student ticket information."
    ]
  };
  const studentNotes = {
    de: "🎓 Studierenden-Hinweis\nWenn du studierst, prüfe vor dem Kauf eines weiteren Tickets, ob dein Semesterticket gültig ist.",
    ar: "🎓 ملاحظة للطلاب\nإذا كنت طالباً، تحقق مما إذا كانت تذكرة الفصل الدراسي صالحة قبل شراء تذكرة أخرى.",
    tr: "🎓 Öğrenci notu\nÖğrenciysen, başka bir bilet almadan önce dönem biletinin geçerli olup olmadığını kontrol et.",
    uk: "🎓 Студентська примітка\nЯкщо ви студент, перевірте, чи дійсний ваш семестровий квиток, перш ніж купувати інший.",
    hi: "🎓 छात्र सूचना\nयदि आप छात्र हैं, तो दूसरा टिकट खरीदने से पहले जांचें कि आपका सेमेस्टर टिकट मान्य है या नहीं.",
    en: "🎓 Student note\nIf you are a student, check whether your semester ticket is valid before purchasing another ticket."
  };
  const limitations = {
    de: "Hinweis:\nDieser Chatbot kann keine Tickets verkaufen oder offiziellen Preise anzeigen, weil die VBN OTP API keine Ticketdaten bereitstellt.",
    ar: "ملاحظة:\nلا يستطيع هذا المساعد بيع التذاكر أو عرض الأسعار الرسمية لأن واجهة VBN OTP API لا توفر بيانات التذاكر.",
    tr: "Not:\nBu sohbet botu bilet satamaz veya resmi fiyatları gösteremez, çünkü VBN OTP API bilet verisi sağlamaz.",
    uk: "Примітка:\nЦей чатбот не може продавати квитки або показувати офіційні ціни, тому що VBN OTP API не надає квиткових даних.",
    hi: "सूचना:\nयह चैटबॉट टिकट नहीं बेच सकता या आधिकारिक कीमतें नहीं दिखा सकता, क्योंकि VBN OTP API टिकट डेटा नहीं देता.",
    en: "Note:\nThis chatbot cannot sell tickets or show official prices because the VBN OTP API does not provide ticket data."
  };
  const lines = [intro[lang] || intro.en, ...(notes[lang] || notes.en)];
  if (isStudent) lines.push(studentNotes[lang] || studentNotes.en);
  lines.push(limitations[lang] || limitations.en);
  return lines.join("\n\n");
}

function stopNameForInstruction(place, fallback) {
  const name = legPlaceName(place, fallback);
  return name ? `"${name}"` : "the stop";
}

function directionText(leg, lang = "en") {
  const headsign = String(leg.headsign || "").trim();
  if (headsign) return ts("towardsH", lang, { h: headsign });
  const destination = legPlaceName(leg.to, "");
  return destination && destination !== "your destination"
    ? ts("towardsH", lang, { h: destination })
    : ts("inDirectionShown", lang);
}

function formatWalkStep(leg, routeResult, index, legs, lang = "en") {
  const minutes = legWalkingMinutes(leg);
  const mins = pluralMinutes(minutes, lang);
  const distance = distanceText(leg.distanceMeters, lang);
  const nextTransit = legs.slice(index + 1).find(item => item.mode !== "WALK");
  const previousTransit = [...legs.slice(0, index)].reverse().find(item => item.mode !== "WALK");
  const from = legPlaceName(leg.from, routeResult.query.start);
  const to = legPlaceName(leg.to, routeResult.query.destination);
  const walkWord = { de: "Gehen Sie etwa", ar: "امشِ حوالي", tr: "Yaklaşık", uk: "Пройдіть приблизно", hi: "लगभग", en: "Walk about" }[lang] || "Walk about";
  const toStop = { de: "zur Haltestelle", ar: "إلى المحطة", tr: "durağına", uk: "до зупинки", hi: "स्टॉप तक", en: "to the stop" }[lang] || "to the stop";
  const toNextStop = { de: "zur nächsten Haltestelle", ar: "إلى المحطة التالية", tr: "sonraki durağa", uk: "до наступної зупинки", hi: "अगले स्टॉप तक", en: "to the next stop" }[lang] || "to the next stop";

  if (nextTransit && !previousTransit) {
    return `${walkWord} ${minutes} ${mins}${distance} ${toStop} ${stopNameForInstruction(nextTransit.from, to)}.`;
  }
  if (nextTransit) {
    return `${walkWord} ${minutes} ${mins}${distance} ${toNextStop} ${stopNameForInstruction(nextTransit.from, to)}.`;
  }
  if (previousTransit) {
    return { de: `Nach dem Aussteigen gehen Sie etwa ${minutes} ${mins}${distance} zu Ihrem Ziel.`, ar: `بعد النزول، امشِ حوالي ${minutes} ${mins}${distance} إلى وجهتك.`, tr: `İndikten sonra hedefinize yaklaşık ${minutes} ${mins}${distance} yürüyün.`, uk: `Після виходу пройдіть приблизно ${minutes} ${mins}${distance} до місця призначення.`, hi: `उतरने के बाद, मंजिल तक लगभग ${minutes} ${mins}${distance} पैदल चलें।`, en: `After you get off, walk about ${minutes} ${mins}${distance} to your destination.` }[lang] || `After you get off, walk about ${minutes} ${mins}${distance} to your destination.`;
  }
  return { de: `Gehen Sie etwa ${minutes} ${mins}${distance} von ${from} nach ${to}.`, ar: `امشِ حوالي ${minutes} ${mins}${distance} من ${from} إلى ${to}.`, tr: `${from}'dan ${to}'ya yaklaşık ${minutes} ${mins}${distance} yürüyün.`, uk: `Пройдіть приблизно ${minutes} ${mins}${distance} від ${from} до ${to}.`, hi: `${from} से ${to} तक लगभग ${minutes} ${mins}${distance} पैदल चलें।`, en: `Walk about ${minutes} ${mins}${distance} from ${from} to ${to}.` }[lang] || `Walk about ${minutes} ${mins}${distance} from ${from} to ${to}.`;
}

function formatTransitStep(leg, lang = "en") {
  const mode = transitModeName(leg.mode);
  const route = leg.route ? ` ${leg.route}` : "";
  const from = stopNameForInstruction(leg.from, "the stop");
  const to = stopNameForInstruction(leg.to, "your stop");
  const dir = directionText(leg, lang);
  const dep = formatClock(leg.departure, lang);
  const arr = formatClock(leg.arrival, lang);
  const takeWord = { de: "Nehmen Sie", ar: "استقل", tr: "Binin:", uk: "Сядьте на", hi: "बोर्ड करें:", en: "Take" }[lang] || "Take";
  const atTime = { de: "um", ar: "الساعة", tr: "saat", uk: "о", hi: "पर", en: "at" }[lang] || "at";
  const fromWord = { de: "von", ar: "من", tr: "'den", uk: "від", hi: "से", en: "from" }[lang] || "from";
  const getOff = { de: `Steigen Sie an ${to} um ${arr} aus.`, ar: `انزل عند ${to} الساعة ${arr}.`, tr: `${to} durağında saat ${arr}'de inin.`, uk: `Вийдіть на ${to} о ${arr}.`, hi: `${to} पर ${arr} पर उतरें।`, en: `Get off at ${to} at ${arr}.` }[lang] || `Get off at ${to} at ${arr}.`;
  return `${takeWord} ${mode}${route} ${atTime} ${dep} ${fromWord} ${from} ${dir}. ${getOff}`;
}

function formatFriendlyRouteReply({ routeResult, message, lang = "en", arriveBy = false, sessionContext = {} }) {
  const selected = bestItinerary(routeResult.itineraries);
  if (!selected) {
    return ts("noUsableRoute", lang);
  }

  const context = newcomerContext(message, lang);
  const deadlineMs = arriveBy ? otpDateTimeMs(routeResult.query.deadlineDate || routeResult.query.otpDate, routeResult.query.deadlineTime || routeResult.query.otpTime) : null;
  const lines = [];

  if (sessionContext.isStudent) context.isStudent = true;
  if (sessionContext.isNewcomer) context.isNewcomer = true;
  if (sessionContext.needsTicketHelp) context.noTicket = true;

  if (context.isNewcomer || context.isConfused) {
    lines.push(`${newcomerWelcome(context, lang)} ${ts("keepSimple", lang)}`);
    lines.push("");
  }

  lines.push(ts("leaveAt", lang, { time: formatClock(selected.startTime, lang) }));
  if (arriveBy && deadlineMs) {
    const deadlineLabel = formatClock(deadlineMs, lang);
    const arrivalLine = {
      de: `Geplante Ankunft: spätestens ${deadlineLabel}.`,
      ar: `الوصول المخطط: قبل ${deadlineLabel}.`,
      tr: `Planlanan varış: en geç ${deadlineLabel}.`,
      uk: `Заплановане прибуття: до ${deadlineLabel}.`,
      hi: `योजनाबद्ध आगमन: ${deadlineLabel} तक।`,
      en: `Arrive by ${deadlineLabel}.`
    }[lang] || `Arrive by ${deadlineLabel}.`;
    lines.push(arrivalLine);
  }

  const firstTransit = firstTransitLeg(selected);
  const lastTransit = lastTransitLeg(selected);
  const firstLeg = selected.legs[0];
  const lastLeg = selected.legs[selected.legs.length - 1];

  if (firstTransit && firstLeg?.mode !== "WALK") {
    lines.push(ts("startAtStop", lang, { stop: stopNameForInstruction(firstTransit.from, routeResult.query.start) }));
  }

  selected.legs.forEach((leg, index) => {
    if (leg.mode === "WALK") {
      lines.push(formatWalkStep(leg, routeResult, index, selected.legs, lang));
    } else {
      lines.push(formatTransitStep(leg, lang));
    }
  });

  if (!selected.legs.some(leg => leg.mode === "WALK")) {
    lines.push(ts("noMappedWalking", lang));
  } else if (lastTransit && lastLeg?.mode !== "WALK") {
    lines.push(ts("finalWalkShort", lang));
  }

  if (routeResult.destinationWalkNotice && selected === routeResult.route) {
    lines.push(ts("destinationWalkNotice", lang, {
      stop: routeResult.destinationWalkNotice.lastStopName,
      minutes: routeResult.destinationWalkNotice.walkMinutes,
      destination: routeResult.destinationWalkNotice.destinationName
    }));
  }

  lines.push(ts("arriveAround", lang, { time: formatClock(selected.endTime, lang) }));
  if (selected.transfers > 0) {
    const extraTime = { de: "Planen Sie etwas extra Zeit am Umstieg ein.", ar: "أعطِ نفسك وقتاً إضافياً عند التبديل.", tr: "Aktarmada kendinize biraz fazla zaman tanıyın.", uk: "Залиште собі трохи більше часу на пересадці.", hi: "बदलाव के स्टॉप पर थोड़ा अतिरिक्त समय रखें.", en: "Give yourself a little extra time at the transfer stop." }[lang] || "Give yourself a little extra time at the transfer stop.";
    const needWord = { de: "Sie benötigen", ar: "ستحتاج إلى", tr: "İhtiyacınız olacak:", uk: "Вам потрібна", hi: "आपको जरूरत होगी:", en: "You will need" }[lang] || "You will need";
    lines.push(`${needWord} ${transferCountStr(selected.transfers, lang)}. ${extraTime}`);
  } else {
    lines.push(ts("noTransferReq", lang));
  }

  const disruption = itineraryDisruptionText(selected, lang);
  if (disruption) lines.push(disruption);

  if (deadlineMs) {
    const bufferMinutes = Math.max(0, Math.round((deadlineMs - selected.endTime) / 60000));
    const confidence = bufferMinutes >= 15
      ? ts("comfortableConn", lang)
      : bufferMinutes >= 10
        ? ts("okayNotLate", lang)
        : ts("tightConn", lang);
    const mins = pluralMinutes(bufferMinutes, lang);
    const bufferLine = { de: `${confidence}: Sie haben etwa ${bufferMinutes} ${mins} Puffer bis zu Ihrem Termin.`, ar: `${confidence}: لديك حوالي ${bufferMinutes} ${mins} كوقت إضافي.`, tr: `${confidence}: Randevunuzdan önce yaklaşık ${bufferMinutes} ${mins} tampon süreniz var.`, uk: `${confidence}: у вас є приблизно ${bufferMinutes} ${mins} запасу.`, hi: `${confidence}: आपके appointment से पहले लगभग ${bufferMinutes} ${mins} का बफर है।`, en: `${confidence}: you have about ${bufferMinutes} ${mins} of buffer before your appointment.` }[lang] || `${confidence}: you have about ${bufferMinutes} ${mins} of buffer before your appointment.`;
    lines.push(bufferLine);
    if (bufferMinutes < 10) lines.push(ts("chooseEarlier", lang));
  }

  const alternatives = (routeResult.itineraries || [])
    .filter(item => item !== selected)
    .slice(0, 2);
  if (alternatives.length) {
    lines.push("");
    lines.push(ts("otherOptions", lang));
  }

  if (messageMentionsTickets(message) || context.noTicket || context.isStudent) {
    lines.push("");
    lines.push(shortRouteTicketNote(lang, context.isStudent));
  }

  if (context.isConfused) {
    lines.push("");
    lines.push(confusionReassurance(lang));
  }

  return lines.join("\n");
}

function compactRouteIntro(message, lang = "en", sessionContext = {}) {
  const context = newcomerContext(message, lang);
  if (sessionContext.isStudent) context.isStudent = true;
  if (sessionContext.isNewcomer) context.isNewcomer = true;
  if (sessionContext.needsTicketHelp) context.noTicket = true;
  return `${newcomerWelcome(context, lang)} ${ts("keepSimple", lang)}`;
}

function walkRecommendedReply(routeResult, lang = "en") {
  const walk = routeResult?.walkRecommendation || {};
  const minutes = Math.max(1, Number(walk.estimatedWalkMinutes) || 1);
  const meters = Math.round(Number(walk.distanceMeters) || 0);
  const distance = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
  const messages = {
    de: `Empfohlen: Zu Fuß. Etwa ${minutes} Min. · ca. ${distance}.`,
    ar: `الموصى به: المشي. حوالي ${minutes} دقيقة · حوالي ${distance}.`,
    tr: `Önerilen: Yürüyün. Yaklaşık ${minutes} dk · yaklaşık ${distance}.`,
    uk: `Рекомендовано: пішки. Близько ${minutes} хв · приблизно ${distance}.`,
    hi: `सुझाव: पैदल जाएं। लगभग ${minutes} मिनट · करीब ${distance}.`,
    en: `Recommended: Walk. About ${minutes} minutes · around ${distance}.`
  };
  return messages[lang] || messages.en;
}

function routeReplyForResult(routeResult, message, lang, context = {}) {
  return routeResult?.walkRecommended
    ? walkRecommendedReply(routeResult, lang)
    : compactRouteIntro(message, lang, context);
}

function routeButtonsForResult(routeResult, lang) {
  if (routeResult?.walkRecommended) return [];

  const buttons = [];
  if (routeResult?.destinationWalkNotice && Number(routeResult.directDestinationAlternativeIndex) >= 0) {
    buttons.push({
      label: ts("routeDirectlyToStop", lang, { destination: routeResult.destinationWalkNotice.destinationName }),
      value: `alternative_route_${routeResult.directDestinationAlternativeIndex}`,
      type: "alternative_route",
      itineraryIndex: routeResult.directDestinationAlternativeIndex
    });
  }

  return [...buttons, ...routeTicketButtons(lang)];
}

function buildWalkingRecommendationRoute(details, from, to, tripTime, options = {}) {
  const straightLineMeters = Math.round(distanceMeters(from, to));
  const estimatedWalkMinutes = Math.max(1, Math.ceil(straightLineMeters / 80));
  const requestedMs = otpDateTimeMs(tripTime.date, tripTime.time) || Date.now();
  const arriveBy = options.arriveBy === true;
  const startMs = arriveBy ? requestedMs - estimatedWalkMinutes * 60000 : requestedMs;
  const endMs = arriveBy ? requestedMs : startMs + estimatedWalkMinutes * 60000;
  const mapsUrl = buildWalkingMapsUrlFromCoords(from, to);
  const requestedOrigin = routeResolvedEndpoint(details.start, from);
  const requestedDestination = routeResolvedEndpoint(details.destination, to);
  const walkLeg = {
    mode: "WALK",
    route: "",
    routeId: "",
    tripId: "",
    headsign: "",
    agencyName: "",
    from: {
      name: from.name || "Origin",
      stopId: "",
      wheelchairBoarding: "unknown",
      lat: from.lat,
      lon: from.lon
    },
    to: {
      name: to.name || "Destination",
      stopId: "",
      wheelchairBoarding: "unknown",
      lat: to.lat,
      lon: to.lon
    },
    fromCoords: { lat: from.lat, lon: from.lon },
    toCoords: { lat: to.lat, lon: to.lon },
    mapsUrl,
    rawCoordinateFields: null,
    steps: [],
    departure: startMs,
    arrival: endMs,
    distanceMeters: straightLineMeters,
    departureDelay: null,
    arrivalDelay: null,
    departureDelayText: null,
    arrivalDelayText: null,
    realTime: false,
    cancelled: false,
    scheduleRelationship: ""
  };
  const itinerary = {
    durationMinutes: estimatedWalkMinutes,
    startTime: startMs,
    endTime: endMs,
    transfers: 0,
    walkingDistanceMeters: straightLineMeters,
    legs: [walkLeg]
  };

  console.log("[WALK FIRST ADDRESS DEBUG]", {
    originText: details.start,
    destinationText: details.destination,
    originType: from?.type,
    destinationType: to?.type,
    originLabel: from?.label || from?.name,
    destinationLabel: to?.label || to?.name,
    mapsUrl
  });

  return {
    ok: true,
    status: 200,
    type: "walk-first-route",
    recommendedMode: "WALK",
    walkRecommended: true,
    walkRecommendation: {
      distanceMeters: straightLineMeters,
      estimatedWalkMinutes,
      mapsUrl
    },
    walk: {
      from: requestedOrigin,
      to: requestedDestination,
      distanceMeters: straightLineMeters,
      estimatedWalkMinutes,
      mapsUrl
    },
    query: {
      start: from.name,
      destination: to.name,
      requestedStart: details.start,
      requestedDestination: details.destination,
      selectedOrigin: requestedOrigin,
      selectedDestination: requestedDestination,
      originCoords: { lat: from.lat, lon: from.lon },
      destinationCoords: { lat: to.lat, lon: to.lon },
      time: details.time || "now",
      otpDate: tripTime.date,
      otpTime: tripTime.time,
      deadlineDate: arriveBy ? tripTime.date : "",
      deadlineTime: arriveBy ? tripTime.time : "",
      arriveBy,
      timeMode: normalizeTimeMode(details.timeMode),
      fromNearbyStops: from.nearbyStops || [],
      toNearbyStops: to.nearbyStops || []
    },
    route: itinerary,
    alternatives: options.transitAlternatives || [],
    itineraries: [itinerary, ...(options.transitAlternatives || [])],
    transitAlternative: (options.transitAlternatives || [])[0] || null,
    source: options.source || "Walking estimate",
    gtfsRt: ""
  };
}

function placeFromKnown(known) {
  const area = areaForCoords(known.lat, known.lon);
  return {
    name: known.name,
    lat: known.lat,
    lon: known.lon,
    area: area ? area.name : "",
    stopId: known.stopId || "",
    type: known.stopId ? "stop" : "place",
    source: "place_correction"
  };
}

function detectPlaceCorrection(text, side = "") {
  const cleaned = cleanRoutePlaceName(text);
  if (!cleaned) {
    console.log("[DETECT PLACE CORRECTION HIT]", {
      side,
      inputText: text,
      cleanedText: cleaned,
      directResolutionSkipped: null,
      correctedText: null,
      correctionFound: false,
      resolvedCorrectedPlace: null
    });
    return null;
  }
  const directResolutionSkipped = placeQueryResolvesDirectly(cleaned);
  if (directResolutionSkipped) {
    console.log("[DETECT PLACE CORRECTION HIT]", {
      side,
      inputText: text,
      cleanedText: cleaned,
      directResolutionSkipped,
      correctedText: null,
      correctionFound: false,
      resolvedCorrectedPlace: null
    });
    return null;
  }

  const correction = correctPlaceTypos(cleaned);
  if (!correction.corrected) {
    console.log("[DETECT PLACE CORRECTION HIT]", {
      side,
      inputText: text,
      cleanedText: cleaned,
      directResolutionSkipped,
      correctedText: correction.text,
      correctionFound: false,
      resolvedCorrectedPlace: null
    });
    return null;
  }

  let known = resolveKnownPlace(correction.text, { exactOnly: true });
  if (!known) {
    for (const aliasQuery of aliasQueriesForPlaceExact(correction.text)) {
      known = resolveKnownPlace(aliasQuery, { exactOnly: true });
      if (known) break;
    }
  }
  if (!known) {
    console.log("[DETECT PLACE CORRECTION HIT]", {
      side,
      inputText: text,
      cleanedText: cleaned,
      directResolutionSkipped,
      correctedText: correction.text,
      correctionFound: false,
      resolvedCorrectedPlace: null
    });
    return null;
  }

  const result = {
    originalText: cleaned,
    confidence: "high",
    place: placeFromKnown(known)
  };
  console.log("[DETECT PLACE CORRECTION HIT]", {
    side,
    inputText: text,
    cleanedText: cleaned,
    directResolutionSkipped,
    correctedText: correction.text,
    correctionFound: true,
    resolvedCorrectedPlace: result.place
  });
  return result;
}

function placeSuggestionPayload(place) {
  const choice = locationChoice(place);
  if (!choice) return null;
  return { label: place.name, ...choice.locationSelection };
}

function buildPlaceCorrectionResult(details, originCorrection, destinationCorrection) {
  const suggestions = [];
  if (originCorrection?.place && destinationCorrection?.place) {
    suggestions.push({
      label: `${originCorrection.place.name} → ${destinationCorrection.place.name}`,
      origin: placeSuggestionPayload(originCorrection.place),
      destination: placeSuggestionPayload(destinationCorrection.place)
    });
  }

  return {
    ok: false,
    status: 200,
    error: "place_correction_suggestions",
    details,
    pendingRoute: {
      originText: details.start,
      destinationText: details.destination,
      requestedDateTime: details.time || "now",
      timeMode: normalizeTimeMode(details.timeMode)
    },
    correction: {
      origin: originCorrection,
      destination: destinationCorrection
    },
    suggestions
  };
}

function pastTimeRouteResult(details, validation) {
  return {
    ok: false,
    status: 200,
    error: "past_time",
    details,
    invalidPastDate: validation.invalidPastDate === true,
    query: { timeMode: normalizeTimeMode(details.timeMode) },
    pastTime: {
      requestedMs: validation.requestedMs,
      hour: validation.hour,
      minute: validation.minute,
      requestedTimeText: validation.requestedDateTime || details.time,
      timeMode: normalizeTimeMode(details.timeMode)
    }
  };
}

async function planRoute(details, fromCoords = null, options = {}) {
  console.time("[Route Timing] total");
  console.time("[Route Timing] parse");
  console.timeEnd("[Route Timing] parse");
  if (!details.start || !details.destination) {
    console.timeEnd("[Route Timing] total");
    return { ok: false, status: 400, error: "missing_trip_details", details };
  }

  const earlyTimeValidation = validateRequestedTime({
    requestedDateTime: details.time,
    explicitDate: details.explicitDate,
    timeMode: details.timeMode,
    selectedLanguage: options.selectedLanguage,
    now: options.now instanceof Date ? options.now : new Date()
  });
  if (earlyTimeValidation.status === "past_time") {
    console.timeEnd("[Route Timing] total");
    return pastTimeRouteResult(details, earlyTimeValidation);
  }

  const skipOriginCorrection = Boolean(options.resolvedStart)
    || Boolean(fromCoords)
    || details.start === "My current location";
  const skipDestinationCorrection = Boolean(options.resolvedDestination);

  const originCorrection = skipOriginCorrection ? null : detectPlaceCorrection(details.start, "origin");
  const destinationCorrection = skipDestinationCorrection ? null : detectPlaceCorrection(details.destination, "destination");
  if (originCorrection || destinationCorrection) {
    console.timeEnd("[Route Timing] total");
    return buildPlaceCorrectionResult(details, originCorrection, destinationCorrection);
  }

  console.time("[Route Timing] place resolution");
  const originPromise = options.resolvedStart
    ? Promise.resolve({ ok: true, source: "selected_location", place: options.resolvedStart })
    : fromCoords && Number.isFinite(Number(fromCoords.lat)) && Number.isFinite(Number(fromCoords.lon))
    ? nearbyVbnStops({
      name: "My current location",
      lat: Number(fromCoords.lat),
      lon: Number(fromCoords.lon)
    }).then(nearbyStops => ({ ok: true, source: "current_location", place: {
      name: "My current location",
      lat: Number(fromCoords.lat),
      lon: Number(fromCoords.lon),
      nearbyStops
    } }))
    : withTimeout(resolveSupportedLocation(details.start, { allowAmbiguous: true }), geocoderTimeoutMs + 1000, "origin place resolution")
      .catch(error => ({ ok: false, error: error.message || "unknown_supported_place", choices: [] }));

  const destinationPromise = options.resolvedDestination
    ? Promise.resolve({ ok: true, source: "selected_location", place: options.resolvedDestination })
    : withTimeout(resolveSupportedLocation(details.destination, { allowAmbiguous: true }), geocoderTimeoutMs + 1000, "destination place resolution")
      .catch(error => ({ ok: false, error: error.message || "unknown_supported_place", choices: [] }));

  const [fromResolution, toResolution] = await Promise.all([originPromise, destinationPromise]);
  console.timeEnd("[Route Timing] place resolution");
  const from = fromResolution?.place;
  const to = toResolution.place;

  if (!from || !to) {
    const failedResolution = from ? toResolution : fromResolution || toResolution;
    const failedQuery = from ? details.destination : details.start;
    const useGenericFallback = isVagueLocationQuery(failedQuery);
    const suggestions = failedResolution?.choices || [];
    const knownPlaceChoices = useGenericFallback
      ? knownPlaces.slice(0, 4).map(place => locationChoice(place)).filter(Boolean)
      : [];
    logSuggestionDebug(from ? "destination" : "start", suggestions.length ? suggestions : knownPlaceChoices);
    console.timeEnd("[Route Timing] total");
    return {
      ok: false,
      status: failedResolution?.error === "ambiguous_supported_place" ? 409 : 422,
      error: failedResolution?.error || "unknown_supported_place",
      details,
      locationRole: from ? "destination" : "start",
      choices: suggestions,
      aliasUsed: failedResolution?.aliasUsed === true,
      knownPlaces: knownPlaces.map(place => place.name),
      knownPlaceChoices
    };
  }

  const arriveBy = options.arriveBy === true || normalizeTimeMode(details.timeMode) === TIME_MODE.ARRIVE_BY;
  const now = options.now instanceof Date ? options.now : new Date();
  const requestedRouteTimeText = datedRouteTimeText(details.time, details.explicitDate);
  const dateTimeResolution = resolveRequestedDateTime(requestedRouteTimeText, now);
  if (dateTimeResolution.status === "past_time") {
    console.timeEnd("[Route Timing] total");
    return {
      ok: false,
      status: 200,
      error: "past_time",
      details,
      query: {
        start: from.name,
        destination: to.name,
        requestedStart: details.start,
        requestedDestination: details.destination,
        selectedOrigin: routeResolvedEndpoint(details.start, from),
        selectedDestination: routeResolvedEndpoint(details.destination, to),
        arriveBy,
        timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT
      },
      pastTime: {
        requestedMs: dateTimeResolution.requestedMs,
        hour: dateTimeResolution.tripTime.hour,
        minute: dateTimeResolution.tripTime.minute,
        requestedTimeText: requestedRouteTimeText || details.time,
        timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT
      }
    };
  }
  let tripTime = dateTimeResolution.tripTime;
  const routeMode = dateTimeResolution.mode;
  const rawText = options.rawText || details.rawText || "";
  const selectedLanguage = normalizeLanguage(options.selectedLanguage || details.selectedLanguage || "en");
  const shortDistanceMeters = Math.round(distanceMeters(from, to));
  const estimatedWalkMinutes = Math.max(1, Math.ceil(shortDistanceMeters / 80));
  const modeDecision = decideRecommendedMode({
    rawText,
    selectedLanguage,
    origin: from,
    destination: to,
    distanceMeters: shortDistanceMeters,
    estimatedWalkMinutes,
    userRequestedTransit: options.userRequestedTransit === true
  });
  const { isWalkable, userRequestedTransit } = modeDecision;
  const recommendWalking = modeDecision.recommendedMode === "WALK";

  const finalRecommendedMode = modeDecision.recommendedMode;

  console.log("[WALK FIRST DEBUG]", {
    rawText,
    originText: details.start,
    destinationText: details.destination,
    resolvedOrigin: { name: from.name, lat: from.lat, lon: from.lon },
    resolvedDestination: { name: to.name, lat: to.lat, lon: to.lon },
    distanceMeters: shortDistanceMeters,
    estimatedWalkMinutes,
    isWalkable,
    userRequestedTransit,
    finalRecommendedMode
  });

  if ((shortDistanceMeters <= 900 || estimatedWalkMinutes <= 12) && !userRequestedTransit && finalRecommendedMode === "TRANSIT") {
    console.error("[BUG WALK FIRST NOT APPLIED]", {
      rawText,
      distanceMeters: shortDistanceMeters,
      estimatedWalkMinutes,
      isWalkable,
      userRequestedTransit,
      finalRecommendedMode
    });
  }

  // Walking remains useful even when live transit data is unavailable.
  if (recommendWalking && !vbnApiKey) {
    console.time("[Route Timing] OTP route");
    console.timeEnd("[Route Timing] OTP route");
    console.time("[Route Timing] alternatives");
    console.timeEnd("[Route Timing] alternatives");
    console.time("[Route Timing] segment alternatives");
    console.timeEnd("[Route Timing] segment alternatives");
    console.time("[Route Timing] render response");
    const walkingResult = buildWalkingRecommendationRoute(details, from, to, tripTime, { arriveBy });
    console.timeEnd("[Route Timing] render response");
    console.timeEnd("[Route Timing] total");
    return walkingResult;
  }

  if (!vbnApiKey) {
    console.error("[Route API Debug] Missing VBN_OTP_API_KEY. Route API call skipped.");
    console.timeEnd("[Route Timing] total");
    return { ok: false, status: 503, error: "missing_api_key" };
  }

  const deadlineTime = { ...tripTime };
  if (arriveBy) {
    const deadlineMs = otpDateTimeMs(tripTime.date, tripTime.time);
    if (deadlineMs) {
      const bufferMinutes = Number.isFinite(Number(options.bufferMinutes)) ? Number(options.bufferMinutes) : 0;
      const target = new Date(deadlineMs - bufferMinutes * 60000);
      tripTime = {
        date: formatDateForOtp(target),
        time: formatTimeForOtp(target)
      };
    }
  }

  const routeCoords = {
    origin: { lat: from.lat, lon: from.lon },
    destination: { lat: to.lat, lon: to.lon },
    requestedOrigin: routeResolvedEndpoint(details.start, from),
    requestedDestination: routeResolvedEndpoint(details.destination, to),
    originLabel: from.name,
    destinationLabel: to.name
  };

  const originText = details.start || "";
  const destinationText = details.destination || "";
  const resolvedOrigin = routeCoords.requestedOrigin;
  const resolvedDestination = routeCoords.requestedDestination;
  const routeCacheKey = JSON.stringify({
    fromLat: Number(from.lat).toFixed(6),
    fromLon: Number(from.lon).toFixed(6),
    toLat: Number(to.lat).toFixed(6),
    toLon: Number(to.lon).toFixed(6),
    time: requestedRouteTimeText || details.time || "now",
    timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
    userRequestedTransit
  });
  const cachedRoute = cacheGet(routeCache, routeCacheKey);
  const cachedRouteIsFresh = cachedRoute
    && (routeMode !== "now" || Number(cachedRoute.route?.startTime) >= Date.now() - 60000);
  if (cachedRouteIsFresh) {
    console.time("[Route Timing] OTP route");
    console.timeEnd("[Route Timing] OTP route");
    console.time("[Route Timing] alternatives");
    console.timeEnd("[Route Timing] alternatives");
    console.time("[Route Timing] segment alternatives");
    console.timeEnd("[Route Timing] segment alternatives");
    console.time("[Route Timing] render response");
    console.timeEnd("[Route Timing] render response");
    console.timeEnd("[Route Timing] total");
    return cachedRoute;
  }

  async function fetchOtpItineraries(queryTripTime) {
    const url = new URL(`${vbnApiBase.replace(/\/$/, "")}/routers/${vbnRouterId}/plan`);
    const requestParams = {
      arriveBy: arriveBy ? "true" : "false",
      date: queryTripTime.date,
      fromPlace: `${from.lat},${from.lon}`,
      toPlace: `${to.lat},${to.lon}`,
      time: queryTripTime.time,
      mode: "WALK,TRANSIT",
      maxWalkDistance: "900",
      numItineraries: "3"
    };
    url.search = new URLSearchParams(requestParams).toString();

    console.log("[ROUTE API TIME DEBUG]", {
      requestedDateTime: requestedRouteTimeText || details.time,
      timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
      arriveBy,
      requestUrl: url.toString(),
      requestBody: null
    });
    console.log("[ROUTE API REQUEST DEBUG]", {
      origin: details.start,
      destination: details.destination,
      requestedDateTime: new Date(otpDateTimeMs(deadlineTime.date, deadlineTime.time)).toISOString(),
      timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
      arriveBy,
      requestUrl: url.toString(),
      requestBody: null
    });

    const { response: apiResponse, data } = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: authHeaderValue(),
        Accept: "application/json"
      }
    }, vbnTimeoutMs);

    if (!apiResponse.ok) {
      return {
        errorResult: {
          ok: false,
          status: apiResponse.status,
          error: "vbn_api_error",
          message: data.error?.msg || data.message || "The VBN OTP API request failed."
        }
      };
    }

    const fetchedItineraries = data.plan && Array.isArray(data.plan.itineraries)
      ? data.plan.itineraries.map(itinerary => normalizeItinerary(itinerary, routeCoords))
      : [];
    return { itineraries: fetchedItineraries };
  }

  const getFirstDepartureTime = itinerary => Number(itinerary?.startTime) || 0;

  console.time("[Route Timing] OTP route");
  let { errorResult: fetchError, itineraries } = await fetchOtpItineraries(tripTime);
  console.timeEnd("[Route Timing] OTP route");
  if (fetchError) {
    if (recommendWalking) {
      console.time("[Route Timing] alternatives");
      console.timeEnd("[Route Timing] alternatives");
      console.time("[Route Timing] segment alternatives");
      console.timeEnd("[Route Timing] segment alternatives");
      console.time("[Route Timing] render response");
      const walkingResult = buildWalkingRecommendationRoute(details, from, to, tripTime, { arriveBy });
      console.timeEnd("[Route Timing] render response");
      console.timeEnd("[Route Timing] total");
      return walkingResult;
    }
    console.timeEnd("[Route Timing] total");
    return fetchError;
  }

  if (arriveBy) {
    const requestedDeadlineMs = otpDateTimeMs(deadlineTime.date, deadlineTime.time);
    itineraries = itineraries.filter(itinerary => itinerarySatisfiesTimeMode(
      itinerary,
      requestedDeadlineMs,
      TIME_MODE.ARRIVE_BY
    ));
  }

  // Never render an itinerary whose first departure is already behind the
  // fresh request-time clock, regardless of language or requested time mode.
  const initialCutoffMs = Date.now() - 60000;
  itineraries = itineraries.filter(itinerary => getFirstDepartureTime(itinerary) >= initialCutoffMs);

  if (routeMode === "now" && !arriveBy && itineraries.length) {
    const cutoffMs = Date.now() - 60000;
    const futureItineraries = itineraries.filter(itinerary => getFirstDepartureTime(itinerary) >= cutoffMs);
    if (futureItineraries.length) {
      itineraries = futureItineraries;
    } else {
      const freshTripTime = parseRouteTime("now", { now: new Date() });
      console.time("[Route Timing] OTP route retry");
      const retry = await fetchOtpItineraries(freshTripTime);
      console.timeEnd("[Route Timing] OTP route retry");
      if (!retry.errorResult) {
        const retryCutoffMs = Date.now() - 60000;
        const retryFuture = retry.itineraries.filter(itinerary => getFirstDepartureTime(itinerary) >= retryCutoffMs);
        itineraries = retryFuture;
        tripTime = freshTripTime;
      }
    }
  }

  console.time("[Route Timing] alternatives");
  const rankedItineraries = userRequestedTransit
    ? [
      ...itineraries.filter(itinerary => itinerary.legs?.some(leg => leg.mode !== "WALK")),
      ...itineraries.filter(itinerary => !itinerary.legs?.some(leg => leg.mode !== "WALK"))
    ]
    : itineraries;
  if (recommendWalking) {
    const transitAlternatives = rankedItineraries
      .filter(itinerary => itinerary.legs?.some(leg => leg.mode !== "WALK"))
      .slice(0, 2);
    console.timeEnd("[Route Timing] alternatives");
    console.time("[Route Timing] segment alternatives");
    console.timeEnd("[Route Timing] segment alternatives");
    console.time("[Route Timing] render response");
    const walkingResult = buildWalkingRecommendationRoute(details, from, to, tripTime, {
      arriveBy,
      transitAlternatives,
      source: transitAlternatives.length ? "Walking estimate with VBN OTP alternatives" : "Walking estimate"
    });
    console.timeEnd("[Route Timing] render response");
    console.timeEnd("[Route Timing] total");
    return walkingResult;
  }
  const selectedItinerary = rankedItineraries[0] || null;
  const alternatives = rankedItineraries.slice(1, 3);
  console.log("[ROUTE RESULT TIME DEBUG]", {
    requestedDateTime: details.time,
    timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
    firstDeparture: selectedItinerary?.startTime || null,
    finalArrival: selectedItinerary?.endTime || null,
    validArrivalBy: arriveBy
      ? Boolean(selectedItinerary) && Number(selectedItinerary.endTime) <= otpDateTimeMs(deadlineTime.date, deadlineTime.time)
      : true
  });
  const requestedDeadlineMs = otpDateTimeMs(deadlineTime.date, deadlineTime.time);
  console.log("[ROUTE RESULT VALIDATION DEBUG]", {
    requestedDateTime: new Date(requestedDeadlineMs).toISOString(),
    timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
    arriveBy,
    firstDeparture: selectedItinerary?.startTime ? new Date(selectedItinerary.startTime).toISOString() : null,
    finalArrival: selectedItinerary?.endTime ? new Date(selectedItinerary.endTime).toISOString() : null,
    validArriveBy: arriveBy
      ? Boolean(selectedItinerary) && Number(selectedItinerary.endTime) <= requestedDeadlineMs
      : true
  });
  console.timeEnd("[Route Timing] alternatives");
  console.time("[Route Timing] segment alternatives");
  console.timeEnd("[Route Timing] segment alternatives");
  const normalizedRoute = selectedItinerary;
  const firstWalkLeg = normalizedRoute?.legs?.find(l => l.mode === "WALK") || null;
  const firstFrom = firstWalkLeg?.fromCoords || firstWalkLeg?.from;

  const selectedLastLeg = selectedItinerary?.legs?.length
    ? selectedItinerary.legs[selectedItinerary.legs.length - 1]
    : null;
  const selectedLastTransitLeg = selectedItinerary ? lastTransitLeg(selectedItinerary) : null;
  const finalWalkLeg = selectedLastLeg?.mode === "WALK" ? selectedLastLeg : null;

  console.log("[ROUTE DESTINATION DEBUG]", {
    requestedDestination: routeCoords.requestedDestination,
    routeApiToPlace: { lat: to.lat, lon: to.lon },
    lastTransitStop: selectedLastTransitLeg?.to || null,
    finalWalkTo: finalWalkLeg?.to || null,
    finalWalkDistance: finalWalkLeg?.distanceMeters ?? null
  });

  let destinationWalkNotice = null;
  let directDestinationAlternativeIndex = -1;

  if (to.type === "stop" && finalWalkLeg && !sameStop(selectedLastTransitLeg?.to, to)) {
    destinationWalkNotice = {
      lastStopName: selectedLastTransitLeg?.to?.name || "",
      destinationName: to.name,
      walkMinutes: legWalkingMinutes(finalWalkLeg),
      walkDistanceMeters: finalWalkLeg.distanceMeters || 0
    };

    directDestinationAlternativeIndex = rankedItineraries.findIndex(itinerary => {
      const itineraryLastTransitLeg = lastTransitLeg(itinerary);
      return itineraryLastTransitLeg && sameStop(itineraryLastTransitLeg.to, to);
    });
  }

  console.log("[SALBEISTRASSE ROUTE DEBUG]", {
    rawText,
    originText,
    destinationText,
    resolvedOrigin,
    resolvedDestination,
    firstWalkLeg,
    allWalkLegs: normalizedRoute?.legs?.filter(l => l.mode === "WALK")
  });

  console.log("[NORMALIZED ROUTE DEBUG]", {
    requestedOrigin: resolvedOrigin,
    requestedDestination: resolvedDestination,
    legs: normalizedRoute?.legs,
    firstWalkLeg: normalizedRoute?.legs?.find(l => l.mode === "WALK"),
    walkingMapUrls: normalizedRoute?.legs
      ?.filter(l => l.mode === "WALK")
      ?.map(l => l.mapsUrl)
  });

  if (resolvedOrigin && firstFrom) {
    const distanceFromRequestedOrigin = haversineMeters(
      resolvedOrigin.lat,
      resolvedOrigin.lon,
      firstFrom.lat,
      firstFrom.lon
    );

    if (distanceFromRequestedOrigin > 80) {
      console.error("[BUG] First walking leg does not start near requested origin", {
        distanceFromRequestedOrigin,
        resolvedOrigin,
        firstWalkLeg
      });
    }
  }

  logRouteCoordinateDebug({
    rawText,
    details,
    resolvedOrigin,
    resolvedDestination,
    route: normalizedRoute
  });

  console.time("[Route Timing] render response");
  const result = {
    ok: true,
    status: 200,
    query: {
      start: from.name,
      destination: to.name,
      requestedStart: details.start,
      requestedDestination: details.destination,
      selectedOrigin: routeCoords.requestedOrigin,
      selectedDestination: routeCoords.requestedDestination,
      originCoords: { lat: from.lat, lon: from.lon },
      destinationCoords: { lat: to.lat, lon: to.lon },
      time: details.time || "now",
      otpDate: tripTime.date,
      otpTime: tripTime.time,
      deadlineDate: arriveBy ? deadlineTime.date : "",
      deadlineTime: arriveBy ? deadlineTime.time : "",
      arriveBy,
      timeMode: arriveBy ? TIME_MODE.ARRIVE_BY : TIME_MODE.DEPART_AT,
      routeMode,
      fromNearbyStops: from.nearbyStops || [],
      toNearbyStops: to.nearbyStops || []
    },
    route: selectedItinerary,
    alternatives,
    itineraries: rankedItineraries,
    destinationWalkNotice,
    directDestinationAlternativeIndex,
    source: "VBN OTP API",
    gtfsRt: "Delay and cancellation fields are passed through when OTP exposes them."
  };
  console.timeEnd("[Route Timing] render response");
  cacheSet(routeCache, routeCacheKey, result, routeCacheTtlMs);
  console.timeEnd("[Route Timing] total");
  return result;
}

async function handleRouteRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const message = String(body.message || "");
    const selectedLanguage = normalizeLanguage(body.selectedLanguage || body.lang || "en");
    const details = body.details && typeof body.details === "object"
      ? {
        start: cleanRoutePlaceName(body.details.start),
        destination: cleanRoutePlaceName(body.details.destination),
        time: cleanRouteTimeText(body.details.time) || "now",
        timeMode: normalizeTimeMode(body.details.timeMode)
      }
      : extractTripDetails(message, selectedLanguage);
    logRouteParseDebug(message || [details.start, details.destination, details.time].filter(Boolean).join(" "), details, selectedLanguage);

    const fromCoords = body.fromCoords && typeof body.fromCoords === "object"
      ? body.fromCoords
      : null;
    const route = await planRoute(details, fromCoords, {
      arriveBy: body.arriveBy === true || normalizeTimeMode(details.timeMode) === TIME_MODE.ARRIVE_BY || messageMentionsArrivalDeadline(message),
      userRequestedTransit: body.userRequestedTransit === true || shouldPreferTransit(message, { selectedLanguage }),
      selectedLanguage,
      rawText: message
    });
    sendJson(res, route.status, route.ok ? route : {
      error: route.error,
      message: route.message,
      details: route.details,
      choices: route.choices,
      knownPlaces: route.knownPlaces
    });
  } catch (error) {
    sendJson(res, 500, { error: "route_handler_error", message: error.message });
  }
}

async function handleSegmentAlternativesRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const leg = body.leg && typeof body.leg === "object" ? body.leg : null;
    if (!leg) {
      sendJson(res, 400, { error: "missing_leg" });
      return;
    }
    console.time("[Route Timing] segment alternatives");
    const alternatives = await withTimeout(
      fetchSegmentAlternativesForLeg(leg),
      segmentAlternativesTimeoutMs,
      "segment alternatives"
    ).catch(error => {
      console.warn("[Segment alternatives] on-demand lookup failed:", error.message);
      return [];
    });
    console.timeEnd("[Route Timing] segment alternatives");
    sendJson(res, 200, { ok: true, alternatives });
  } catch (error) {
    sendJson(res, 500, { error: "segment_alternatives_error", message: error.message });
  }
}

async function handleClearSessionRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || "").trim();
    if (sessionId) sessions.delete(sessionId);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: "clear_session_error", message: error.message });
  }
}

function createSession() {
  return {
    route: { start: "", destination: "", time: "", explicitDate: "", timeMode: TIME_MODE.DEPART_AT },
    fromCoords: null,
    pendingLocation: null,
    pendingRoute: null,
    selectedLocations: {
      start: null,
      destination: null
    },
    ticketFlowStatus: "none",
    selectedTicket: "",
    selectedLanguage: "en",
    context: {
      isStudent: false,
      isNewcomer: false,
      needsTicketHelp: false
    },
    messages: [],
    lastSeen: Date.now()
  };
}

function selectedPlaceFromPayload(value) {
  if (!value || typeof value !== "object") return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  const name = cleanPlaceName(value.resolvedName || value.name || value.value || "");
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    placeId: String(value.placeId || value.id || `${normalizeText(name)}:${lat.toFixed(5)}:${lon.toFixed(5)}`),
    stopId: String(value.stopId || ""),
    name,
    lat,
    lon,
    area: String(value.area || areaForCoords(lat, lon)?.name || ""),
    source: String(value.source || ""),
    type: String(value.type || (value.stopId ? "stop" : "place")),
    nearbyStops: Array.isArray(value.nearbyStops) ? value.nearbyStops.slice(0, 4) : []
  };
}

function routeSelectionFromPayload(value) {
  if (!value || typeof value !== "object") return null;
  const origin = selectedPlaceFromPayload(value.origin);
  const destination = selectedPlaceFromPayload(value.destination);
  if (!origin || !destination) return null;
  return {
    origin,
    destination,
    requestedDateTime: String(value.requestedDateTime || "now")
  };
}

function pendingChoiceForMessage(session, message) {
  const pending = session.pendingLocation;
  if (!pending || !Array.isArray(pending.choices)) return null;
  const normalized = normalizeText(message);
  if (!normalized) return null;

  return pending.choices.find(choice => {
    const selection = choice.locationSelection || {};
    return [
      choice.label,
      choice.value,
      selection.name,
      selection.resolvedName
    ].some(item => normalizeText(item) === normalized);
  }) || null;
}

function applySelectedLocation(session, selectedLocation, role) {
  const place = selectedPlaceFromPayload(selectedLocation);
  const targetRole = role === "start" ? "start" : "destination";
  if (!place) return null;

  session.pendingLocation = null;
  session.selectedLocations[targetRole] = place;
  session.route[targetRole] = place.name;
  if (targetRole === "start") {
    session.fromCoords = {
      lat: place.lat,
      lon: place.lon
    };
  }
  return place;
}

function getSession(sessionId) {
  pruneSessions();
  const id = String(sessionId || "").trim() || cryptoRandomId();
  if (!sessions.has(id)) sessions.set(id, createSession());
  const session = sessions.get(id);
  if (!session.selectedLocations) session.selectedLocations = { start: null, destination: null };
  if (!("pendingLocation" in session)) session.pendingLocation = null;
  if (!("pendingRoute" in session)) session.pendingRoute = null;
  if (!session.ticketFlowStatus) session.ticketFlowStatus = "none";
  if (!("selectedTicket" in session)) session.selectedTicket = "";
  session.lastSeen = Date.now();
  return { id, session };
}

function cryptoRandomId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rememberMessage(session, role, content) {
  session.lastSeen = Date.now();
  session.messages.push({ role, content: String(content || "").slice(0, 1200) });
  if (session.messages.length > maxSessionMessages) {
    session.messages = session.messages.slice(-maxSessionMessages);
  }
}

function pruneSessions() {
  const cutoff = Date.now() - sessionTtlMs;
  for (const [id, session] of sessions.entries()) {
    if ((session.lastSeen || 0) < cutoff) sessions.delete(id);
  }
}

function quickButtonsForMissing(missing, lang = "en") {
  if (missing !== "start") return [];
  return [
    { label: ts("useCurrentLoc", lang), value: "__current_location__" },
    { label: ts("typeLocManually", lang), value: "__type_location_manually__" }
  ];
}

function quickButtonsForChoices(choices) {
  return (choices || []).slice(0, 4).map(choice => {
    const item = typeof choice === "string" ? { label: choice, value: choice } : choice;
    const button = {
      label: item.label || item.name,
      value: item.value || item.label || item.name
    };
    if (item.locationSelection) {
      button.locationSelection = item.locationSelection;
    }
    return button;
  });
}

const ticketLinks = [
  {
    label: "🎫 Buy ticket",
    url: "https://www.vbn.de/tickets"
  },
  {
    label: "ℹ️ Ticket Information",
    url: "https://www.vbn.de/tickets/ticketuebersicht"
  },
  {
    label: "Open in Maps",
    url: "https://www.google.com/maps"
  }
];

function localizedTicketLabels(lang) {
  const labels = {
    de: ["🎫 Ticket kaufen", "ℹ️ Ticketinformationen", "Karte öffnen"],
    ar: ["🎫 شراء تذكرة", "ℹ️ معلومات التذاكر", "فتح الخريطة"],
    tr: ["🎫 Bilet al", "ℹ️ Bilet bilgisi", "Haritada aç"],
    uk: ["🎫 Купити квиток", "ℹ️ Інформація про квитки", "Відкрити карту"],
    hi: ["🎫 टिकट खरीदें", "ℹ️ टिकट जानकारी", "मैप खोलें"],
    en: ["🎫 Buy ticket", "ℹ️ Ticket information", "Open in Maps"]
  };
  return labels[lang] || labels.en;
}

function ticketQuickButtons(lang) {
  const labels = localizedTicketLabels(lang);
  return ticketLinks.slice(0, 2).map((link, index) => ({
    label: labels[index] || link.label,
    url: link.url,
    external: true
  }));
}

function coordParam(coords) {
  const lat = Number(coords?.lat);
  const lon = Number(coords?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function routeTicketButtons(lang) {
  return [
    { label: ts("yesHaveTicket", lang), value: ts("yesHaveTicket", lang), action: "ticket_has" },
    { label: ts("noNeedTicket", lang), value: ts("noNeedTicket", lang), action: "ticket_need" },
    { label: ts("notSure", lang), value: ts("notSure", lang), action: "ticket_unsure" }
  ];
}

function routeSummaryForDemo(routeResult, lang = "en") {
  const selected = routeResult?.route || bestItinerary(routeResult?.itineraries || []);
  if (!selected) return "";

  const firstTransit = firstTransitLeg(selected);
  const routePart = firstTransit
    ? `${transitModeName(firstTransit.mode)} ${firstTransit.route || ""}`.trim()
    : ts("walkRoute", lang);

  const toWord = { de: "nach", ar: "إلى", tr: "→", uk: "до", hi: "→", en: "to" }[lang] || "to";
  const timeConnector = { de: "bis", ar: "إلى", tr: "→", uk: "до", hi: "से", en: "to" }[lang] || "to";
  return [
    `${routeResult.query.start} ${toWord} ${routeResult.query.destination}`,
    `${routePart}, ${formatClock(selected.startTime, lang)} ${timeConnector} ${formatClock(selected.endTime, lang)}`,
    selected.transfers > 0
      ? transferCountStr(selected.transfers, lang)
      : ts("noTransferLabel", lang)
  ].join(" | ");
}

function ticketFallbackWithContext(lang, context = {}) {
  return shortRouteTicketNote(lang, context.isStudent);
}

function dbIceTicketMessage(lang) {
  const messages = {
    de: "Dieser Chatbot unterstützt vor allem öffentlichen Nahverkehr in Oldenburg und Bremen. Für DB- oder ICE-Ticketgültigkeit prüfe bitte die offizielle DB-Website oder die DB Navigator App, weil ICE-Ticketregeln nicht von der VBN OTP API bereitgestellt werden.\n\nVBN/VWG-Ticketinformationen gelten für lokalen Nahverkehr. ICE ist Fernverkehr und kann andere Ticketregeln haben.",
    ar: "يدعم هذا المساعد بشكل أساسي النقل العام المحلي في أولدنبورغ وبريمن. لمعرفة صلاحية تذاكر DB أو ICE، يرجى التحقق من موقع DB الرسمي أو تطبيق DB Navigator، لأن قواعد تذاكر ICE لا توفرها واجهة VBN OTP API.\n\nمعلومات تذاكر VBN/VWG مخصصة للنقل المحلي. ICE قطار لمسافات طويلة وقد تكون له قواعد تذاكر مختلفة.",
    tr: "Bu chatbot ağırlıklı olarak Oldenburg ve Bremen’deki yerel toplu taşımayı destekler. DB veya ICE bilet geçerliliği için lütfen resmi DB web sitesini ya da DB Navigator uygulamasını kontrol et, çünkü ICE bilet kuralları VBN OTP API tarafından sağlanmaz.\n\nVBN/VWG bilet bilgileri yerel toplu taşıma içindir. ICE uzun mesafe trendir ve farklı bilet kuralları olabilir.",
    uk: "Цей чатбот переважно підтримує місцевий громадський транспорт в Ольденбурзі та Бремені. Щодо чинності квитків DB або ICE перевірте офіційний сайт DB або застосунок DB Navigator, тому що правила квитків ICE не надаються VBN OTP API.\n\nІнформація VBN/VWG стосується місцевого громадського транспорту. ICE - це далеке залізничне сполучення, де можуть діяти інші правила квитків.",
    hi: "यह chatbot मुख्य रूप से Oldenburg और Bremen में local public transport के लिए है। DB या ICE ticket validity के लिए कृपया official DB website या DB Navigator app देखें, क्योंकि ICE ticket rules VBN OTP API में उपलब्ध नहीं हैं.\n\nVBN/VWG ticket information local public transport के लिए है। ICE long-distance rail है और उसके ticket rules अलग हो सकते हैं.",
    en: "This chatbot mainly supports public transport in Oldenburg and Bremen. For DB or ICE ticket validity, please check the official DB website or DB Navigator app, because ICE ticket rules are not provided by the VBN OTP API.\n\nVBN/VWG ticket information is for local public transport. ICE is long-distance rail and may follow different ticket rules."
  };
  return messages[lang] || messages.en;
}

function ticketRouteNote(lang, isStudent = false) {
  return shortRouteTicketNote(lang, isStudent);
}

function messageMentionsTickets(message) {
  const normalized = normalizeText(message);
  const raw = String(message || "").toLowerCase();
  const normalizedKeywords = [
    "ticket", "tickets", "fare", "fares", "price", "prices", "buy", "purchase", "payment", "pay",
    "db ticket", "ice ticket", "train ticket", "long distance", "long distance rail", "ticket validity", "validity",
    "deutschlandticket", "deutschland ticket", "student ticket", "semesterticket", "semester ticket", "abo",
    "tarif", "tarife", "fahrkarte", "fahrkarten", "fahrschein", "preis", "preise", "kaufen", "bezahlen", "zahlung",
    "bilet", "ucret", "fiyat", "satin", "odeme"
  ];
  const rawKeywords = [
    "تذكرة", "تذاكر", "التذكرة", "سعر", "شراء", "دفع",
    "квиток", "квитки", "тариф", "ціна", "купити", "оплата",
    "टिकट", "किराया", "कीमत", "खरीद", "भुगतान"
  ];

  return normalizedKeywords.some(keyword => normalized.includes(keyword))
    || rawKeywords.some(keyword => raw.includes(keyword));
}

function messageMentionsRoute(message) {
  const text = String(message || "");
  return /\b(route|trip|travel|go|plan|directions?|guide me|how do i get|how to get|take me|fahrt|fahren|verbindung|reise|route|plane|wie komme ich|رحلة|مسار|nereden|nereye|rota|yolculuk|звідки|куди|маршрут|поїздка|रूट|यात्रा)\b/i.test(text)
    || /\bfrom\s+.+\s+to\s+.+/i.test(text)
    || /\bvon\s+.+\s+(?:nach|zu|zur|zum)\s+.+/i.test(text);
}

function messageMentionsTicketOnlyTerms(message) {
  const normalized = normalizeText(message);
  return [
    "db ticket",
    "ice ticket",
    "ice tickets",
    "train ticket",
    "train tickets",
    "long distance",
    "long distance rail",
    "deutschlandticket",
    "deutschland ticket",
    "ticket validity",
    "validity",
    "valid",
    "fare",
    "fares",
    "price",
    "prices",
    "purchase",
    "buy ticket",
    "ticket purchase",
    "vbn ticket",
    "vwg ticket"
  ].some(term => normalized.includes(term));
}

function isTicketOnlyQuestion(message) {
  return (messageMentionsTickets(message) || messageMentionsTicketOnlyTerms(message))
    && !messageMentionsRoute(message);
}

function isDbOrIceTicketQuestion(message) {
  const normalized = normalizeText(message);
  return [
    "db",
    "ice",
    "intercity express",
    "long distance",
    "long distance rail"
  ].some(term => normalized.includes(term))
    && (messageMentionsTickets(message) || messageMentionsTicketOnlyTerms(message));
}

function clearRouteMemory(session) {
  session.route = { start: "", destination: "", time: "", timeMode: TIME_MODE.DEPART_AT };
  session.fromCoords = null;
  session.pendingLocation = null;
  session.pendingRoute = null;
  session.selectedLocations = { start: null, destination: null };
}

function clearTicketFlow(session) {
  session.ticketFlowStatus = "none";
  session.selectedTicket = "";
}

function syncTicketFlowFromBody(session, body) {
  const allowed = new Set(["none", "asking_ticket", "selecting_ticket", "payment_started", "payment_completed"]);
  const status = String(body.ticketFlowStatus || "").trim();
  if (allowed.has(status)) session.ticketFlowStatus = status;
  if (typeof body.selectedTicket === "string") session.selectedTicket = body.selectedTicket.slice(0, 120);
}

function messageLooksLikeRouteIntent(message) {
  const normalized = normalizeText(message);
  return messageMentionsRoute(message)
    || /\b(i am|i'm|im|ich bin|from|start|starting|origin|in)\b.+\b(want to go|go to|to|nach|zur|zum)\b/i.test(String(message || ""))
    || /\b(salbeistrasse|salbeistraße|lappan|hauptbahnhof|bahnhof|universitat|universitaet|university|zob)\b/.test(normalized);
}

function memoryPayload(session) {
  return {
    route: session.route,
    selectedLanguage: session.selectedLanguage,
    context: session.context,
    pendingLocation: session.pendingLocation,
    pendingRoute: session.pendingRoute,
    selectedLocations: session.selectedLocations,
    ticketFlowStatus: session.ticketFlowStatus,
    selectedTicket: session.selectedTicket
  };
}

function newcomerContext(message, lang) {
  const normalized = normalizeText(message);
  const raw = String(message || "").toLowerCase();
  const isStudent = /\b(student|students|international student|exchange student|uni|university|dorm|dormitory|studentenwohnheim|wohnheim|semester|semesterticket|studierende|طالب|öğrenci|студент|छात्र)\b/i.test(raw);
  const isNewcomer = /\b(new|new here|newcomer|just arrived|arrived|first time|tourist|exchange|resident|moved|lost|confused|neu|angekommen|zum ersten mal|tourist|verwirrt)\b/i.test(raw)
    || /وصلت|جديد|لأول مرة|kayboldum|yeniyim|вперше|новий|загубив|अभी आया|नया|पहली बार/.test(raw);
  const isConfused = /\b(confused|lost|not sure|do not know|don't know|help|hilfe|verwirrt|keine ahnung)\b/i.test(raw)
    || /ضائع|مرتبك|bilmiyorum|kayboldum|не знаю|загубив|पता नहीं|मदद/.test(raw);
  const noTicket = /\b(no ticket|without ticket|need ticket|do not have a ticket|don't have a ticket|kein ticket|keine fahrkarte|ticket brauche)\b/i.test(raw);
  const city = normalized.includes("bremen") ? "Bremen" : normalized.includes("oldenburg") ? "Oldenburg" : "";

  return {
    isStudent,
    isNewcomer,
    isConfused,
    noTicket,
    city,
    language: lang
  };
}

function updateSessionContext(session, context, interpretation) {
  session.context = session.context || {
    isStudent: false,
    isNewcomer: false,
    needsTicketHelp: false
  };

  const aiContext = interpretation?.context || {};
  session.context.isStudent = Boolean(session.context.isStudent || context.isStudent || aiContext.isStudent);
  session.context.isNewcomer = Boolean(session.context.isNewcomer || context.isNewcomer || aiContext.isNewcomer);
  session.context.needsTicketHelp = Boolean(session.context.needsTicketHelp || context.noTicket || context.needsTicketHelp || aiContext.needsTicketHelp);
}

function messageIndicatesCurrentLocation(message) {
  return /\b(i just arrived|just arrived|i am at|i'm at|i am in|i'm in|im in|i am standing at|i'm standing at|i have reached|i reached|i am currently at|i'm currently at|arrived at|standing at|currently at|gerade angekommen|ich bin am|ich bin gerade|وصلت|أنا في|şu anda|geldim|зараз|я прибув|अभी पहुँचा|मैं अभी)\b/i.test(String(message || ""));
}

function applyCurrentLocationDefaults(session, message) {
  if (!messageIndicatesCurrentLocation(message)) return;
  if (session.route.start && session.route.destination && !session.route.time) {
    session.route.time = "now";
  }
}

function extractCurrentLocationRouteContext(message) {
  const text = String(message || "");
  if (!messageIndicatesCurrentLocation(text)) return {};

  const startMatch = text.match(/\b(?:i just arrived at|just arrived at|i am at|i'm at|i am in|i'm in|im in|i am standing at|i'm standing at|i have reached|i reached|i am currently at|i'm currently at|arrived at|standing at|currently at)\s+([^.!?]+?)(?=\s+(?:and|\.|,|i am|i want|i need|want to|$))/i);
  const destinationMatch = text.match(/\b(?:want to go to|need to go to|going to|go to|to)\s+([^.!?]+?)(?=\s*(?:\.|,|i do not|i don't|i am|i need|$))/i);

  return {
    start: startMatch ? normalizeStationReference(cleanRoutePlaceName(startMatch[1]), text) : "",
    destination: destinationMatch ? cleanRoutePlaceName(destinationMatch[1]) : "",
    time: extractTimeText(text) || "now"
  };
}

function mergeRouteFallback(session, fallback) {
  if (fallback.start && (!session.route.start || normalizeText(session.route.start) === "railway station" || normalizeText(session.route.start) === "station")) {
    if (normalizeText(fallback.start) !== normalizeText(session.route.start)) {
      session.selectedLocations.start = null;
    }
    session.route.start = fallback.start;
  }
  if (fallback.destination && (!session.route.destination || isVagueDestination(session.route.destination))) {
    if (normalizeText(fallback.destination) !== normalizeText(session.route.destination)) {
      session.selectedLocations.destination = null;
    }
    session.route.destination = fallback.destination;
  }
  if (fallback.time && !session.route.time) {
    session.route.time = fallback.time;
  }
}

function newcomerWelcome(context, lang = "en") {
  if (context.city === "Bremen") return ts("welcomeBremen", lang);
  if (context.city === "Oldenburg") return ts("welcomeOldenburg", lang);
  return ts("welcomeGeneral", lang);
}

function newcomerTicketNote(context, lang) {
  if (context.isStudent) {
    return ticketRouteNote(lang, true);
  }
  return ticketRouteNote(lang);
}

function confusionReassurance(lang) {
  return ts("showToDriver", lang);
}

function isLikelyStandalonePlaceMessage(message) {
  const text = cleanPlaceName(message);
  if (!text || text.length > 80) return false;
  if (extractTimeText(text)) return false;
  if (/\b(from|to|nach|von|zur|zum|route|fahrt|ticket|delay|verspät|accessible|barrierefrei)\b/i.test(text)) return false;
  return normalizeText(text).split(" ").length <= 5;
}

function isLikelyPlaceSearchText(message) {
  const normalized = normalizeText(message);
  return /\b(place|address|street|office|hospital|station|center|centre|city|stadt|zentrum|innenstadt|rathaus|burgerburo|buergerbuero|auslander|auslaender|university|universitat|universitaet|dorm|wohnheim|landmark)\b/.test(normalized)
    || aliasQueriesForPlace(message).length > 0;
}

function locationOutsideMessage(lang) {
  return ts("locOutside", lang, { areas: supportedAreaNames() });
}

function locationAmbiguousMessage(lang) {
  return ts("locAmbiguous", lang);
}

function foundStartMessage(place, lang) {
  const stop = (place.nearbyStops || [])[0];
  const area = place.area || areaForCoords(place.lat, place.lon)?.name || "";
  const stopName = stop?.name || "";
  const messages = {
    de: `Ich habe ${place.name}${area ? ` in ${area}` : ""} gefunden.${stopName ? ` Ich nutze die nächste Haltestelle: ${stopName}.` : " Ich nutze die nächste Haltestelle."} Wohin möchtest du fahren?`,
    ar: `وجدت ${place.name}${area ? ` في ${area}` : ""}.${stopName ? ` سأستخدم أقرب محطة نقل عام: ${stopName}.` : " سأستخدم أقرب محطة نقل عام."} إلى أين تريد الذهاب؟`,
    tr: `${place.name}${area ? `, ${area}` : ""} bulundu.${stopName ? ` En yakın toplu taşıma durağını kullanacağım: ${stopName}.` : " En yakın toplu taşıma durağını kullanacağım."} Nereye gitmek istiyorsunuz?`,
    uk: `Я знайшов ${place.name}${area ? ` у ${area}` : ""}.${stopName ? ` Використаю найближчу зупинку громадського транспорту: ${stopName}.` : " Використаю найближчу зупинку громадського транспорту."} Куди ви хочете поїхати?`,
    hi: `मुझे ${place.name}${area ? `, ${area}` : ""} मिल गया.${stopName ? ` मैं निकटतम सार्वजनिक परिवहन स्टॉप का उपयोग करूंगा: ${stopName}.` : " मैं निकटतम सार्वजनिक परिवहन स्टॉप का उपयोग करूंगा."} आप कहाँ जाना चाहते हैं?`,
    en: `I found ${place.name}${area ? ` in ${area}` : ""}.${stopName ? ` I’ll use the nearest public transport stop: ${stopName}.` : " I’ll use the nearest public transport stop."} Where do you want to go?`
  };
  return messages[lang] || messages.en;
}

async function handleStandalonePlaceMessage(message, lang, session) {
  if (!isLikelyStandalonePlaceMessage(message) || session.route.destination) return null;

  const resolution = await resolveSupportedLocation(message, { allowAmbiguous: true });
  if (resolution.ok) {
    session.pendingLocation = null;
    session.route.start = resolution.place.name;
    session.route.destination = "";
    session.route.time = "";
    session.selectedLocations.start = selectedPlaceFromPayload(locationChoice(resolution.place)?.locationSelection) || null;
    session.selectedLocations.destination = null;
    session.fromCoords = {
      lat: resolution.place.lat,
      lon: resolution.place.lon
    };
    return {
      reply: foundStartMessage(resolution.place, lang),
      quickButtons: []
    };
  }

  if (resolution.error === "ambiguous_supported_place") {
    session.pendingLocation = {
      role: "start",
      choices: resolution.choices
    };
    return {
      reply: locationAmbiguousMessage(lang),
      quickButtons: quickButtonsForChoices(resolution.choices)
    };
  }

  if (resolution.error === "outside_supported_area") {
    return {
      reply: locationOutsideMessage(lang),
      quickButtons: []
    };
  }

  if (isLikelyPlaceSearchText(message)) {
    return {
      reply: ts("noPlaceSuggestions", lang),
      quickButtons: []
    };
  }

  return null;
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAI(input, options = {}) {
  if (!openaiApiKey) {
    throw new Error("missing_openai_api_key");
  }

  const payload = {
    model: openaiModel,
    input,
    temperature: options.temperature ?? 0.2
  };

  if (options.jsonSchema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: options.jsonSchema.name,
        schema: options.jsonSchema.schema,
        strict: true
      }
    };
  }

  const { response, data } = await fetchJsonWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, openaiTimeoutMs);

  if (!response.ok) {
    const error = new Error(data.error?.message || "OpenAI API request failed.");
    error.code = "openai_api_error";
    error.status = response.status;
    throw error;
  }

  return extractResponseText(data);
}

function messagesForOllama(input) {
  return input.map(item => ({
    role: item.role,
    content: typeof item.content === "string" ? item.content : JSON.stringify(item.content)
  }));
}

async function callOllama(input, options = {}) {
  if (!ollamaBaseUrl || !ollamaModel) {
    throw new Error("missing_ollama_config");
  }

  const payload = {
    model: ollamaModel,
    messages: messagesForOllama(input),
    stream: false,
    options: {
      temperature: options.temperature ?? 0.2
    }
  };

  if (options.jsonSchema) {
    payload.format = options.jsonSchema.schema;
  }

  const { response, data } = await fetchJsonWithTimeout(`${ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, ollamaTimeoutMs);

  if (!response.ok) {
    const error = new Error(data.error || data.message || "Ollama API request failed.");
    error.code = "ollama_api_error";
    error.status = response.status;
    throw error;
  }

  return String(data.message?.content || data.response || "").trim();
}

function hasAiBackend() {
  return Boolean(ollamaBaseUrl && ollamaModel) || Boolean(openaiApiKey);
}

function aiBackendSetupMessage(lang = "en") {
  return ts("aiSetupMissing", lang);
}

async function callAi(input, options = {}) {
  if (ollamaBaseUrl && ollamaModel) {
    return callOllama(input, options);
  }

  return callOpenAI(input, options);
}

function parseAiJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response was not valid JSON.");
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      throw new Error("AI response was not valid JSON: " + e.message);
    }
  }
}

function chatbotSystemPrompt(lang, session) {
  const langLabel = supportedLanguageLabels[lang] || lang;
  console.log("[Chat] system prompt language:", langLabel);
  return [
    "You are Oldenburg Transport KI, a public transport assistant for Oldenburg and Bremen.",
    "You behave like ChatGPT: natural, concise, friendly, contextual, and non-repetitive.",
    "Your scope is only buses, trams, trains, stops, route planning, delays, cancellations, tickets, and accessibility for Oldenburg and Bremen, Germany.",
    `The user selected this interface language: ${langLabel}.`,
    `LANGUAGE REQUIREMENT (mandatory): You must respond only in ${langLabel}. All explanations, route summaries, ticket questions, route option labels, and fallback messages must be in ${langLabel}. Do not respond in English unless the selected language is English. If the user writes in another language, still answer in the selected interface language. This overrides all other instructions.`,
    "Use beginner-friendly language for newcomers, tourists, international students, exchange students, and people with language barriers.",
    "Do not invent live transport data. The server will call VBN OTP when route fields are complete.",
    "VBN OTP does not provide ticket prices or purchase data. For ticket questions, explain this briefly and direct users to official VBN/VWG ticket info.",
    "Intent priority is: ticket-only question first, route planning second, accessibility third, general help fourth.",
    "DB tickets, ICE tickets, Deutschlandticket, train tickets, long-distance rail, ticket validity, fares, and ticket purchase are ticket-only questions unless the user clearly asks for a route.",
    "Do not use remembered route context when the new user message is clearly a ticket-only question.",
    "For accessibility, use wheelchair_boarding data when route data is available; if unknown, say it is unknown and suggest confirming with VBN/VWG.",
    "Extract and maintain route fields: start, destination, time. Treat local streets, addresses, landmarks, districts, and stop names as valid locations.",
    "Extract context too: current location, destination, student/newcomer status, ticket need, and language preference.",
    "If the user says they just arrived, are at a place, are standing at a place, have reached a place, or are currently at a place, set that place as the start. If no future time is mentioned, set time to 'now'.",
    "If the user says railway station or train station, map it to Oldenburg Hauptbahnhof when Oldenburg is mentioned, or Bremen Hauptbahnhof when Bremen is mentioned.",
    "If the user says they have a train, event, meeting, or appointment at a place and says where they are staying or starting, treat that place as the destination and the user's lodging/start point as the start.",
    "If the user seems confused and route fields are missing, ask only one simple follow-up question.",
    "If destination and time are known but start is missing, ask only for the start location.",
    "Return only JSON matching the schema.",
    `Selected language: ${lang} (${langLabel}). Respond exclusively in ${langLabel}.`,
    `Current remembered route: ${JSON.stringify(session.route)}.`
  ].join("\n");
}

async function interpretMessageWithAi(message, lang, session) {
  const input = [
    {
      role: "system",
      content: chatbotSystemPrompt(lang, session)
    },
    ...session.messages.map(item => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content
    })),
    {
      role: "user",
      content: message
    }
  ];

  const schema = {
    name: "oldenburg_chat_interpretation",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          enum: ["route", "ticket", "accessibility", "delay", "greeting", "out_of_scope", "other"]
        },
        route: {
          type: "object",
          additionalProperties: false,
          properties: {
            start: { type: "string" },
            destination: { type: "string" },
            time: { type: "string" }
          },
          required: ["start", "destination", "time"]
        },
        missing: {
          type: "string",
          enum: ["", "start", "destination", "time"]
        },
        shouldPlanRoute: { type: "boolean" },
        needsAccessibility: { type: "boolean" },
        assistantDraft: { type: "string" },
        context: {
          type: "object",
          additionalProperties: false,
          properties: {
            currentLocation: { type: "string" },
            destination: { type: "string" },
            isStudent: { type: "boolean" },
            isNewcomer: { type: "boolean" },
            needsTicketHelp: { type: "boolean" },
            languagePreference: { type: "string" }
          },
          required: ["currentLocation", "destination", "isStudent", "isNewcomer", "needsTicketHelp", "languagePreference"]
        }
      },
      required: ["intent", "route", "missing", "shouldPlanRoute", "needsAccessibility", "assistantDraft", "context"]
    }
  };

  return parseAiJson(await callAi(input, { jsonSchema: schema, temperature: 0.1 }));
}

function mergeRouteState(session, route, message = "") {
  if (route.start) {
    const nextStart = cleanRoutePlaceName(normalizeStationReference(route.start, message));
    if (normalizeText(nextStart) !== normalizeText(session.route.start)) {
      session.selectedLocations.start = null;
    }
    session.route.start = nextStart;
  }
  if (route.destination) {
    const nextDestination = cleanRoutePlaceName(normalizeStationReference(route.destination, message));
    if (normalizeText(nextDestination) !== normalizeText(session.route.destination)) {
      session.selectedLocations.destination = null;
    }
    session.route.destination = nextDestination;
  }
  if (route.time) session.route.time = cleanRouteTimeText(route.time);
  if (route.explicitDate) session.route.explicitDate = route.explicitDate;
  if (route.timeMode) session.route.timeMode = normalizeTimeMode(route.timeMode);

  if (session.route.destination) {
    const resolved = aliasQueriesForPlace(session.route.destination).length > 1
      ? null
      : resolveKnownPlace(session.route.destination, { exactOnly: true });
    if (resolved) session.route.destination = resolved.name;
  }

  if (session.route.start && session.route.start !== "My current location") {
    const resolved = aliasQueriesForPlace(session.route.start).length > 1
      ? null
      : resolveKnownPlace(session.route.start, { exactOnly: true });
    if (resolved) session.route.start = resolved.name;
  }
}

function isNewRouteRequest(session, route) {
  if (!route || !session.route.destination) return false;
  const nextDestination = cleanRoutePlaceName(route.destination);
  const nextTime = cleanPlaceName(route.time);
  const nextStart = cleanRoutePlaceName(route.start);

  if (nextStart) return false;
  if (!nextDestination || !nextTime) return false;

  const resolvedNext = resolveKnownPlace(nextDestination);
  const normalizedNext = normalizeText(resolvedNext ? resolvedNext.name : nextDestination);
  const normalizedCurrent = normalizeText(session.route.destination);

  return normalizedNext && normalizedNext !== normalizedCurrent;
}

function explicitlyReusesOrigin(message) {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  return [
    "same starting point",
    "same start",
    "same origin",
    "from the same place",
    "from same place",
    "from there",
    "again from",
    "gleicher start",
    "gleicher startpunkt",
    "vom gleichen ort",
    "von dort"
  ].some(term => normalized.includes(term));
}

function isDestinationOnlyRoute(route) {
  return Boolean(cleanRoutePlaceName(route?.destination)) && !cleanRoutePlaceName(route?.start);
}

function resetRouteOrigin(session) {
  session.route.start = "";
  session.fromCoords = null;
  if (!session.selectedLocations) session.selectedLocations = { start: null, destination: null };
  session.selectedLocations.start = null;
}

function rememberPendingDestinationRoute(session, route, message = "", resolvedDestination = null) {
  const destination = cleanRoutePlaceName(normalizeStationReference(route.destination, message));
  const time = String(route.time || "").trim() || "now";
  resetRouteOrigin(session);
  session.route.destination = destination;
  session.route.time = time;
  session.route.timeMode = normalizeTimeMode(route.timeMode);
  session.route.explicitDate = route.explicitDate || detectExplicitDate(time);
  session.selectedLocations.destination = resolvedDestination || null;
  session.pendingLocation = null;
  session.pendingRoute = {
    mode: "awaiting_origin",
    destinationText: destination,
    destination: resolvedDestination
      ? {
        label: resolvedDestination.name,
        name: resolvedDestination.name,
        lat: resolvedDestination.lat,
        lon: resolvedDestination.lon,
        source: resolvedDestination.source || "",
        type: resolvedDestination.type || "place"
      }
      : null,
    requestedDateTime: time,
    timeMode: session.route.timeMode,
    explicitDate: session.route.explicitDate,
    time,
    createdAt: Date.now()
  };
  console.log("[PENDING ROUTE CREATED DEBUG]", {
    pendingRoute: session.pendingRoute
  });
}

async function routeResponseFromSession({ session, message, lang, arriveBy = false, completedRoute = null }) {
  const routeToPlan = completedRoute || {
    requestedDateTime: session.route.time,
    timeMode: session.route.timeMode
  };
  console.log("[ROUTE API ARRIVEBY DEBUG]", {
    requestedDateTime: routeToPlan?.requestedDateTime,
    timeMode: routeToPlan?.timeMode,
    arriveBy: normalizeTimeMode(routeToPlan?.timeMode) === TIME_MODE.ARRIVE_BY
  });
  const routeResult = await planRoute(
    session.route,
    session.route.start === "My current location" ? session.fromCoords : null,
    routeOptionsFromSession(session, arriveBy, message)
  );
  if (completedRoute) {
    const finalArrival = routeResult.route?.endTime || null;
    const requested = resolveRequestedDateTime(completedRoute.requestedDateTime, new Date());
    const requestedDateTimeMs = requested.status === "ok"
      ? otpDateTimeMs(requested.tripTime.date, requested.tripTime.time)
      : NaN;
    console.log("[ARRIVE BY RESULT DEBUG]", {
      requestedDateTime: completedRoute.requestedDateTime,
      finalArrival,
      validArriveBy: completedRoute.timeMode !== TIME_MODE.ARRIVE_BY
        || (Boolean(finalArrival) && Number(finalArrival) <= requestedDateTimeMs)
    });
  }
  let reply = routeErrorMessage(routeResult.error, lang, choicesForRouteResult(routeResult));
  let quickButtons = [];

  if (routeResult.ok) {
    session.pendingLocation = null;
    session.pendingRoute = null;
    session.ticketFlowStatus = routeResult.walkRecommended ? "none" : "asking_ticket";
    session.lastRouteResult = routeResult;
    reply = routeReplyForResult(routeResult, message, lang, session.context);
    quickButtons = routeButtonsForResult(routeResult, lang);
  } else if (routeResult.error === "past_time") {
    session.pendingLocation = null;
    const clarification = pastTimeClarificationResponse(routeResult, session, lang);
    reply = clarification.reply;
    quickButtons = clarification.quickButtons;
  } else if (routeResult.error === "place_correction_suggestions") {
    const correctionResponse = responseForPlaceCorrection(session, routeResult, lang);
    reply = correctionResponse.reply;
    quickButtons = correctionResponse.quickButtons;
  } else {
    quickButtons = quickButtonsForChoices(
      routeResult.choices?.length ? routeResult.choices : (routeResult.knownPlaceChoices || [])
    );
    if (routeResult.error === "ambiguous_supported_place" && routeResult.choices?.length) {
      session.pendingLocation = {
        role: routeResult.locationRole || "destination",
        choices: routeResult.choices
      };
    } else if (routeResult.error === "unknown_supported_place" && routeResult.knownPlaceChoices?.length) {
      session.pendingLocation = {
        role: routeResult.locationRole || "destination",
        choices: routeResult.knownPlaceChoices
      };
    }
  }

  return { reply, quickButtons, routeResult };
}

async function responseForDestinationOnlyRoute({ session, route, message, lang }) {
  if (explicitlyReusesOrigin(message) && session.route.start) {
    mergeRouteState(session, route, message);
    return routeResponseFromSession({
      session,
      message,
      lang,
      arriveBy: arriveByForRoute(route, message)
    });
  }

  const destinationText = cleanRoutePlaceName(normalizeStationReference(route.destination, message));
  if (normalizeTimeMode(route.timeMode) === TIME_MODE.ARRIVE_BY) {
    const destinationResolution = await resolveSupportedLocation(destinationText, { allowAmbiguous: true });
    console.log("[Place Resolve Debug]", {
      destinationText,
      aliasQueries: aliasQueriesForPlace(destinationText),
      destinationResult: destinationResolution
    });

    if (!destinationResolution.ok) {
      rememberPendingDestinationRoute(session, { ...route, destination: destinationText }, message, null);
      if (destinationResolution.error === "ambiguous_supported_place" && destinationResolution.choices?.length) {
        session.pendingLocation = {
          role: "destination",
          choices: destinationResolution.choices
        };
        return {
          reply: routeErrorMessage(destinationResolution.error, lang, choicesForRouteResult(destinationResolution)),
          quickButtons: quickButtonsForChoices(destinationResolution.choices),
          routeResult: destinationResolution
        };
      }
    } else {
      rememberPendingDestinationRoute(session, { ...route, destination: destinationText }, message, destinationResolution.place);
      return {
        reply: ts("askRouteOriginForDestination", lang, { destination: destinationResolution.place?.name || destinationText }),
        quickButtons: quickButtonsForMissing("start", lang),
        routeResult: null
      };
    }
  }

  rememberPendingDestinationRoute(session, { ...route, destination: destinationText }, message, null);
  const askOriginReply = normalizeText(destinationText) === "stadt oldenburg"
    ? ts("askRouteOrigin", lang)
    : ts("askRouteOriginForDestination", lang, { destination: destinationText });
  return {
    reply: askOriginReply,
    quickButtons: quickButtonsForMissing("start", lang),
    routeResult: null
  };
}

function originTextFromPendingReply(message, lang) {
  const routeFromMessage = extractTripDetails(message, lang);
  if (routeFromMessage.start && !routeFromMessage.destination) return routeFromMessage.start;

  return cleanRoutePlaceName(message)
    .replace(/^(?:from|starting\s+from|start\s+from|von|ab)\s+/i, "")
    .trim();
}

async function responseForPendingOrigin({ session, message, lang }) {
  const pending = session.pendingRoute;
  if (!pending || pending.mode !== "awaiting_origin") return null;

  const routeFromMessage = extractTripDetails(message, lang);
  if (routeFromMessage.start && routeFromMessage.destination) {
    session.pendingRoute = null;
    clearRouteMemory(session);
    mergeRouteState(session, routeFromMessage, message);
    return routeResponseFromSession({
      session,
      message,
      lang,
      arriveBy: arriveByForRoute(routeFromMessage, message)
    });
  }

  const origin = originTextFromPendingReply(message, lang);
  if (!origin) return null;

  const completedRoute = {
    originText: origin,
    origin: null,
    destinationText: pending.destinationText,
    destination: pending.destination,
    requestedDateTime: pending.requestedDateTime,
    explicitDate: pending.explicitDate,
    timeMode: pending.timeMode
  };
  console.log("[PENDING ROUTE COMPLETED DEBUG]", {
    enteredOriginText: origin,
    pendingRoute: pending,
    completedRoute
  });

  session.route.start = completedRoute.originText;
  session.route.destination = completedRoute.destinationText;
  session.route.time = completedRoute.requestedDateTime;
  session.route.timeMode = completedRoute.timeMode;
  session.route.explicitDate = completedRoute.explicitDate;
  session.fromCoords = null;
  if (!session.selectedLocations) session.selectedLocations = { start: null, destination: null };
  session.selectedLocations.start = null;
  session.pendingRoute = null;

  return routeResponseFromSession({
    session,
    message,
    lang,
    arriveBy: completedRoute.timeMode === TIME_MODE.ARRIVE_BY,
    completedRoute
  });
}

// Handles the reply to the "X has already passed" clarification: either
// "Next route now" or "Tomorrow at X" quick reply, or a brand-new request.
async function responseForPendingTimeChoice({ session, message, lang }) {
  const pending = session.pendingRoute;
  if (!pending || !["awaiting_past_time_choice", "awaiting_different_time"].includes(pending.mode)) return null;

  const normalized = normalizeText(message);
  const isRouteNow = normalized === normalizeText(pending.nextRouteLabel || "");
  const isRouteTomorrow = normalized === normalizeText(pending.tomorrowLabel || "");
  const isDifferentTime = pending.mode === "awaiting_different_time"
    || normalized === normalizeText(pending.differentTimeLabel || ts("enterDifferentTime", lang));

  if (isDifferentTime) {
    if (pending.mode !== "awaiting_different_time") {
      session.pendingRoute = { ...pending, mode: "awaiting_different_time" };
      return { reply: ts("typeDifferentTime", lang), quickButtons: [], routeResult: null };
    }
    const routeFromMessage = extractTripDetails(message, lang);
    if (!routeFromMessage.time || routeFromMessage.time === "now") return null;
    session.route.time = routeFromMessage.time;
    session.route.timeMode = normalizeTimeMode(pending.timeMode);
    const validation = validateRequestedTime({ requestedDateTime: session.route.time, explicitDate: session.route.explicitDate, timeMode: session.route.timeMode, selectedLanguage: lang, now: new Date() });
    if (validation.status === "past_time") return pastTimeClarificationResponse(pastTimeRouteResult(session.route, validation), session, lang);
    session.pendingRoute = null;
    if (!session.route.start) {
      return { reply: ts("askRouteOriginForDestination", lang, { destination: session.route.destination }), quickButtons: quickButtonsForMissing("start", lang), routeResult: null };
    }
    return routeResponseFromSession({ session, message, lang, arriveBy: arriveByForRoute(session.route, message) });
  }

  if (!isRouteNow && !isRouteTomorrow) {
      const routeFromMessage = extractTripDetails(message, lang);
    if (routeFromMessage.start || routeFromMessage.destination || (routeFromMessage.time && routeFromMessage.time !== "now")) {
      session.pendingRoute = null;
      mergeRouteState(session, routeFromMessage, message);
      return routeResponseFromSession({
        session,
        message,
        lang,
        arriveBy: arriveByForRoute(routeFromMessage, message)
      });
    }
    return null;
  }

  session.pendingRoute = null;
  session.route.time = isRouteNow ? "now" : `tomorrow ${pad2(pending.hour)}:${pad2(pending.minute)}`;
  session.route.timeMode = normalizeTimeMode(pending.timeMode || session.route.timeMode);
  session.route.explicitDate = isRouteNow ? "" : "tomorrow";

  if (!session.route.start) {
    rememberPendingDestinationRoute(session, session.route, message, session.selectedLocations?.destination || pending.destination);
    return {
      reply: ts("askRouteOriginForDestination", lang, { destination: session.route.destination }),
      quickButtons: quickButtonsForMissing("start", lang),
      routeResult: null
    };
  }

  return routeResponseFromSession({
    session,
    message,
    lang,
    arriveBy: arriveByForRoute(session.route, message)
  });
}

// Handles the reply to a "Did you mean ...?" place-correction prompt: either
// "Enter different places" / "Enter another origin" / "Enter another
// destination", or a brand-new route request typed directly.
async function responseForPendingPlaceCorrection({ session, message, lang }) {
  const pending = session.pendingRoute;
  if (!pending || pending.mode !== "awaiting_place_correction") return null;

  const normalized = normalizeText(message);
  const pendingRouteInfo = pending.pendingRoute || {};

  if (normalized === normalizeText(ts("enterDifferentPlaces", lang))) {
    session.pendingRoute = null;
    clearRouteMemory(session);
    return {
      reply: ts("askRouteOrigin", lang),
      quickButtons: quickButtonsForMissing("start", lang),
      routeResult: null
    };
  }

  if (normalized === normalizeText(ts("enterAnotherOrigin", lang))) {
    session.pendingRoute = null;
    session.pendingLocation = null;
    session.route.start = "";
    session.fromCoords = null;
    session.selectedLocations.start = null;
    session.route.destination = pendingRouteInfo.destinationText || session.route.destination;
    session.route.time = session.route.time || pendingRouteInfo.requestedDateTime || "now";
    session.route.timeMode = normalizeTimeMode(pendingRouteInfo.timeMode || session.route.timeMode);
    return {
      reply: ts("askRouteOrigin", lang),
      quickButtons: [],
      routeResult: null
    };
  }

  if (normalized === normalizeText(ts("enterAnotherDestination", lang))) {
    session.pendingRoute = null;
    session.pendingLocation = null;
    session.route.destination = "";
    session.selectedLocations.destination = null;
    session.route.start = pendingRouteInfo.originText || session.route.start;
    session.route.time = session.route.time || pendingRouteInfo.requestedDateTime || "now";
    session.route.timeMode = normalizeTimeMode(pendingRouteInfo.timeMode || session.route.timeMode);
    return {
      reply: ts("sureDest", lang),
      quickButtons: [],
      routeResult: null
    };
  }

  const routeFromMessage = extractTripDetails(message, lang);
  if (routeFromMessage.start && routeFromMessage.destination) {
    session.pendingRoute = null;
    session.pendingLocation = null;
    clearRouteMemory(session);
    mergeRouteState(session, routeFromMessage, message);
    return routeResponseFromSession({
      session,
      message,
      lang,
      arriveBy: arriveByForRoute(routeFromMessage, message)
    });
  }

  return null;
}

function missingRouteField(session) {
  if (!session.route.destination) return "destination";
  if (isVagueDestination(session.route.destination)) return "destination";
  if (!session.route.start) return "start";
  if (!session.route.time) return "time";
  return "";
}

function isVagueDestination(value) {
  const normalized = normalizeText(value);
  return [
    "my student dorm",
    "student dorm",
    "student dormitory",
    "dorm",
    "dormitory",
    "studentenwohnheim",
    "wohnheim",
    "my dorm",
    "residence"
  ].includes(normalized);
}

function exactPlaceNotFoundMessage(lang) {
  const messages = {
    de: "Ich konnte den genauen Ort nicht finden. Meinst du einen dieser Orte?",
    ar: "لم أتمكن من العثور على المكان بدقة. هل تقصد أحد هذه الخيارات؟",
    tr: "Tam yeri bulamadım. Bunlardan birini mi kastettin?",
    uk: "Я не зміг знайти точне місце. Ви мали на увазі один із цих варіантів?",
    hi: "मैं सटीक जगह नहीं ढूंढ पाया। क्या आपका मतलब इनमें से किसी से है?",
    en: "I could not find the exact place. Did you mean one of these?"
  };
  return messages[lang] || messages.en;
}

function quickButtonsForPlaceCorrection(routeResult, lang) {
  const buttons = (routeResult.suggestions || []).map(suggestion => ({
    label: suggestion.label,
    value: suggestion.label,
    routeSelection: {
      origin: suggestion.origin,
      destination: suggestion.destination,
      requestedDateTime: routeResult.pendingRoute?.requestedDateTime || "now"
    }
  }));
  const enterDifferent = ts("enterDifferentPlaces", lang);
  buttons.push({ label: enterDifferent, value: enterDifferent });
  return buttons;
}

function quickButtonsForSinglePlaceCorrection(correction, role, lang) {
  const buttons = [];
  const choice = locationChoice(correction.place);
  if (choice) {
    buttons.push({ label: choice.value, value: choice.value, locationSelection: choice.locationSelection });
  }
  const enterLabel = role === "start" ? ts("enterAnotherOrigin", lang) : ts("enterAnotherDestination", lang);
  buttons.push({ label: enterLabel, value: enterLabel });
  return buttons;
}

// Stores the pending correction state and builds the "did you mean" reply
// for a place_correction_suggestions planRoute result.
function responseForPlaceCorrection(session, routeResult, lang) {
  const corr = routeResult.correction || {};
  session.pendingLocation = null;

  if (corr.origin && corr.destination && routeResult.suggestions?.length) {
    session.pendingRoute = {
      mode: "awaiting_place_correction",
      side: "both",
      pendingRoute: routeResult.pendingRoute,
      createdAt: Date.now()
    };
    return {
      reply: ts("didYouMeanThesePlaces", lang),
      quickButtons: quickButtonsForPlaceCorrection(routeResult, lang),
      routeResult
    };
  }

  const role = corr.origin ? "start" : "destination";
  const correction = corr.origin || corr.destination;
  session.pendingRoute = {
    mode: "awaiting_place_correction",
    side: role,
    pendingRoute: routeResult.pendingRoute,
    createdAt: Date.now()
  };
  const choice = locationChoice(correction.place);
  session.pendingLocation = choice ? { role, choices: [choice] } : null;

  return {
    reply: ts("didYouMeanPlace", lang, { original: correction.originalText, place: correction.place.name }),
    quickButtons: quickButtonsForSinglePlaceCorrection(correction, role, lang),
    routeResult
  };
}

function routeErrorMessage(error, lang, suggestions = []) {
  if (error === "missing_api_key") return ts("missingApiKey", lang);
  if (error === "exact_address_not_found") return ts("exactAddressNotFound", lang);
  if (error === "unknown_supported_place") {
    return suggestions?.length ? exactPlaceNotFoundMessage(lang) : ts("noPlaceSuggestions", lang);
  }
  if (error === "outside_supported_area") return locationOutsideMessage(lang);
  if (error === "ambiguous_supported_place") return locationAmbiguousMessage(lang);
  return ts("vbnFetchError", lang);
}

// Builds the "X has already passed" clarification reply and stores the
// pending choice so responseForPendingTimeChoice can resolve it next turn.
function pastTimeClarificationResponse(routeResult, session, lang) {
  const pastTime = routeResult.pastTime || {};
  if (routeResult.invalidPastDate) {
    session.pendingRoute = {
      mode: "awaiting_different_time",
      originText: session.route.start || null,
      destinationText: session.route.destination || null,
      destination: session.selectedLocations?.destination || null,
      requestedDateTime: session.route.time,
      timeMode: normalizeTimeMode(session.route.timeMode),
      missingOrigin: !session.route.start,
      createdAt: Date.now()
    };
    return { reply: ts("invalidPastDateTime", lang), quickButtons: [] };
  }
  const timeLabel = formatClock(pastTime.requestedMs, lang);
  const isArrivalMode = normalizeTimeMode(pastTime.timeMode || routeResult.query?.timeMode || session.route?.timeMode) === TIME_MODE.ARRIVE_BY;
  const nextRouteLabel = ts("nextRouteNow", lang);
  const tomorrowLabel = ts("tomorrowAtTime", lang, { time: timeLabel });
  const differentTimeLabel = ts("enterDifferentTime", lang);

  session.pendingRoute = {
    mode: "awaiting_past_time_choice",
    originText: session.route.start || null,
    destinationText: session.route.destination || null,
    destination: session.selectedLocations?.destination || null,
    requestedDateTime: pastTime.requestedTimeText || session.route.time,
    missingOrigin: !session.route.start,
    hour: pastTime.hour,
    minute: pastTime.minute,
    requestedTimeText: pastTime.requestedTimeText || session.route.time,
    timeMode: isArrivalMode ? TIME_MODE.ARRIVE_BY : normalizeTimeMode(session.route.timeMode),
    explicitDate: "today",
    nextRouteLabel,
    tomorrowLabel,
    differentTimeLabel,
    createdAt: Date.now()
  };

  return {
    reply: ts("timeAlreadyPassedChoose", lang, { time: timeLabel }),
    quickButtons: [
      { label: nextRouteLabel, value: nextRouteLabel },
      { label: tomorrowLabel, value: tomorrowLabel },
      { label: differentTimeLabel, value: differentTimeLabel }
    ]
  };
}

function choicesForRouteResult(routeResult) {
  return routeResult?.choices?.length ? routeResult.choices : (routeResult?.knownPlaceChoices || []);
}

function routeOptionsFromSession(session, arriveBy = false, message = "") {
  const parsedArriveBy = normalizeTimeMode(session.route?.timeMode) === TIME_MODE.ARRIVE_BY;
  return {
    arriveBy: arriveBy === true || parsedArriveBy,
    userRequestedTransit: shouldPreferTransit(message, { selectedLanguage: session.selectedLanguage }),
    selectedLanguage: session.selectedLanguage,
    resolvedStart: session.selectedLocations?.start || null,
    resolvedDestination: session.selectedLocations?.destination || null,
    rawText: message
  };
}

function promptForMissingAfterSelection(missing, place, role, lang) {
  if (role === "start" && missing === "destination") {
    return foundStartMessage(place, lang);
  }

  if (missing === "start") return ts("destSavedAskStart", lang);
  if (missing === "destination") return ts("startSavedAskDest", lang);
  if (missing === "time") return ts("startSavedAskTime", lang);
  return role === "start" ? ts("startSaved", lang) : ts("destSaved", lang);
}

async function responseAfterSelectedLocation({ session, place, role, message, lang }) {
  const pendingRouteBeforeSelection = session.pendingRoute ? { ...session.pendingRoute } : null;
  if (role === "destination" && pendingRouteBeforeSelection?.mode === "awaiting_origin") {
    const completedPendingRoute = {
      ...pendingRouteBeforeSelection,
      destination: place,
      destinationText: place.name,
      requestedDateTime: pendingRouteBeforeSelection.requestedDateTime,
      explicitDate: pendingRouteBeforeSelection.explicitDate,
      timeMode: normalizeTimeMode(pendingRouteBeforeSelection.timeMode),
      originText: pendingRouteBeforeSelection.originText ?? null,
      origin: pendingRouteBeforeSelection.origin ?? null
    };
    const hasOrigin = Boolean(completedPendingRoute.originText || completedPendingRoute.origin);
    console.log("[PLACE SELECTION STATE DEBUG]", {
      pendingRouteBeforeSelection,
      selectedPlace: place,
      completedPendingRoute,
      hasOrigin,
      nextAction: hasOrigin ? "plan_route" : "ask_origin"
    });

    session.route.destination = completedPendingRoute.destinationText;
    session.route.time = completedPendingRoute.requestedDateTime;
    session.route.explicitDate = completedPendingRoute.explicitDate;
    session.route.timeMode = completedPendingRoute.timeMode;

    if (!hasOrigin) {
      resetRouteOrigin(session);
      session.selectedLocations.destination = place;
      session.pendingRoute = { ...completedPendingRoute, mode: "awaiting_origin" };
      console.log("[MISSING ORIGIN AFTER PLACE SELECTION DEBUG]", {
        destinationText: completedPendingRoute.destinationText,
        requestedDateTime: completedPendingRoute.requestedDateTime,
        timeMode: completedPendingRoute.timeMode,
        originText: completedPendingRoute.originText,
        origin: completedPendingRoute.origin
      });
      return {
        reply: ts("askRouteOriginForDestination", lang, { destination: completedPendingRoute.destinationText }),
        quickButtons: quickButtonsForMissing("start", lang),
        routeResult: null
      };
    }
  }

  const missing = missingRouteField(session);
  if (missing) {
    return {
      reply: promptForMissingAfterSelection(missing, place, role, lang),
      quickButtons: quickButtonsForMissing(missing, lang),
      routeResult: null
    };
  }

  const arriveBy = arriveByForRoute(session.route, message);
  const routeResult = await planRoute(
    session.route,
    session.route.start === "My current location" ? session.fromCoords : null,
    routeOptionsFromSession(session, arriveBy, message)
  );

  if (routeResult.ok) {
    session.pendingLocation = null;
    session.pendingRoute = null;
    session.ticketFlowStatus = routeResult.walkRecommended ? "none" : "asking_ticket";
    session.lastRouteResult = routeResult;
    return {
      reply: routeReplyForResult(routeResult, message, lang, session.context),
      quickButtons: routeButtonsForResult(routeResult, lang),
      routeResult
    };
  }

  if (routeResult.error === "past_time") {
    session.pendingLocation = null;
    return { ...pastTimeClarificationResponse(routeResult, session, lang), routeResult };
  }

  const unresolvedRole = role === "start" ? "destination" : "start";
  if (routeResult.error === "ambiguous_supported_place" && routeResult.choices?.length) {
    session.pendingLocation = {
      role: routeResult.locationRole || unresolvedRole,
      choices: routeResult.choices
    };
  } else if (routeResult.error === "unknown_supported_place") {
    const knownChoices = routeResult.knownPlaceChoices || [];
    if (knownChoices.length) {
      session.pendingLocation = {
        role: routeResult.locationRole || unresolvedRole,
        choices: knownChoices
      };
    }
  }

  return {
    reply: routeErrorMessage(routeResult.error, lang, choicesForRouteResult(routeResult)),
    quickButtons: quickButtonsForChoices(
      routeResult.choices?.length ? routeResult.choices : (routeResult.knownPlaceChoices || [])
    ),
    routeResult
  };
}

async function responseAfterRouteSelection({ session, routeSelection, message, lang }) {
  session.pendingLocation = null;
  session.pendingRoute = null;
  session.selectedLocations.start = routeSelection.origin;
  session.selectedLocations.destination = routeSelection.destination;
  session.route.start = routeSelection.origin.name;
  session.route.destination = routeSelection.destination.name;
  session.fromCoords = { lat: routeSelection.origin.lat, lon: routeSelection.origin.lon };
  if (routeSelection.requestedDateTime && routeSelection.requestedDateTime !== "now") {
    session.route.time = routeSelection.requestedDateTime;
  } else if (!session.route.time) {
    session.route.time = "now";
  }
  if (!session.route.timeMode) session.route.timeMode = TIME_MODE.DEPART_AT;

  const arriveBy = arriveByForRoute(session.route, message);
  const routeResult = await planRoute(
    session.route,
    session.fromCoords,
    routeOptionsFromSession(session, arriveBy, message)
  );

  const usingPrefix = ts("usingCorrectedPlaces", lang, {
    origin: routeSelection.origin.name,
    destination: routeSelection.destination.name
  });

  if (routeResult.ok) {
    session.ticketFlowStatus = routeResult.walkRecommended ? "none" : "asking_ticket";
    session.lastRouteResult = routeResult;
    return {
      reply: `${usingPrefix}\n\n${routeReplyForResult(routeResult, message, lang, session.context)}`,
      quickButtons: routeButtonsForResult(routeResult, lang),
      routeResult
    };
  }

  if (routeResult.error === "past_time") {
    const clarification = pastTimeClarificationResponse(routeResult, session, lang);
    return {
      reply: `${usingPrefix}\n\n${clarification.reply}`,
      quickButtons: clarification.quickButtons,
      routeResult
    };
  }

  return {
    reply: routeErrorMessage(routeResult.error, lang, choicesForRouteResult(routeResult)),
    quickButtons: quickButtonsForChoices(
      routeResult.choices?.length ? routeResult.choices : (routeResult.knownPlaceChoices || [])
    ),
    routeResult
  };
}

function validCoords(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function responseAfterCurrentLocation({ session, coords, message, lang }) {
  session.pendingLocation = null;
  session.route.start = "My current location";
  session.fromCoords = coords;
  session.selectedLocations.start = null;

  if (!session.route.destination || isVagueDestination(session.route.destination)) {
    return {
      reply: ts("foundLocAskDest", lang),
      quickButtons: [],
      routeResult: null
    };
  }

  if (!session.route.time) {
    session.route.time = "now";
  }

  const arriveBy = arriveByForRoute(session.route, message);
  const routeResult = await planRoute(
    session.route,
    session.fromCoords,
    routeOptionsFromSession(session, arriveBy, message)
  );

  if (routeResult.ok) {
    session.pendingLocation = null;
    session.pendingRoute = null;
    session.ticketFlowStatus = routeResult.walkRecommended ? "none" : "asking_ticket";
    session.lastRouteResult = routeResult;
    return {
      reply: routeReplyForResult(routeResult, message, lang, session.context),
      quickButtons: routeButtonsForResult(routeResult, lang),
      routeResult
    };
  }

  if (routeResult.error === "past_time") {
    session.pendingLocation = null;
    return { ...pastTimeClarificationResponse(routeResult, session, lang), routeResult };
  }

  if (routeResult.error === "ambiguous_supported_place" && routeResult.choices?.length) {
    session.pendingLocation = {
      role: routeResult.locationRole || "destination",
      choices: routeResult.choices
    };
  } else if (routeResult.error === "unknown_supported_place") {
    const knownChoices = routeResult.knownPlaceChoices || [];
    if (knownChoices.length) {
      session.pendingLocation = {
        role: routeResult.locationRole || "destination",
        choices: knownChoices
      };
    }
  }

  return {
    reply: routeErrorMessage(routeResult.error, lang, choicesForRouteResult(routeResult)),
    quickButtons: quickButtonsForChoices(
      routeResult.choices?.length ? routeResult.choices : (routeResult.knownPlaceChoices || [])
    ),
    routeResult
  };
}

async function composeFinalAnswer({ message, lang, session, interpretation, routeResult }) {
  const input = [
    {
      role: "system",
      content: [
        "You are a friendly AI chatbot for public transport in Oldenburg and Bremen.",
        `The user selected this interface language: ${supportedLanguageLabels[lang] || lang}.`,
        `LANGUAGE REQUIREMENT (mandatory): Respond exclusively in ${supportedLanguageLabels[lang] || lang}. Every word must be in that language. Do not use English unless the selected language is English. If the user writes in another language, still answer in the selected interface language.`,
        "Answer naturally and concisely.",
        "Use route data exactly as provided. Do not invent lines, delays, or cancellations.",
        "If the user also asks about tickets, fares, prices, buying, payment, Deutschlandticket, or student tickets, do not answer that part here. The server appends the official ticket note separately.",
        "For accessibility, mention wheelchair boarding fields when present and say unknown when unknown.",
        "Keep answers step-by-step and avoid generic repeated fallbacks.",
        `Selected language: ${lang} (${supportedLanguageLabels[lang] || lang}).`
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        userMessage: message,
        rememberedRoute: session.route,
        interpretation,
        routeResult
      })
    }
  ];

  return callAi(input, { temperature: 0.4 });
}

async function handleChatRequest(req, res) {
  let lang = "en";
  const sendBotJson = (status, payload) => {
    console.log("[Bot Message Debug]", payload);
    console.log("[BOT RESPONSE OUT]", {
      type: payload?.type,
      text: payload?.reply ?? payload?.text,
      error: payload?.error,
      quickReplies: payload?.quickButtons ?? payload?.quickReplies,
      message: payload
    });
    sendJson(res, status, payload);
  };
  try {
    const body = await readJsonBody(req);
    const message = String(body.message || "").trim();
    console.log("[CHAT REQUEST ACTIVE]", {
      body,
      rawText: body?.message || body?.text || body?.input
    });
    console.log("[RAW INPUT DEBUG]", { rawText: message });
    console.log("[HANDLE CHAT REQUEST HIT]", {
      body,
      text: body?.message || body?.text || body?.input,
      hasRouteSelection: Boolean(body?.routeSelection),
      hasLocationSelection: Boolean(body?.selectedLocation)
    });
    lang = normalizeLanguage(body.selectedLanguage || body.lang || "en");
    console.log("[Chat Flow Debug] raw user text:", message);
    console.log("[Chat Flow Debug] selected language:", lang);
    console.log("[Chat] backend received language:", body.selectedLanguage || body.lang, "normalized:", lang);
    const { id: sessionId, session } = getSession(body.sessionId);
    session.selectedLanguage = lang;
    syncTicketFlowFromBody(session, body);

    if (!message) {
      sendBotJson(400, { error: "empty_message", sessionId });
      return;
    }

    const deterministicRoute = extractTripDetails(message, lang);
    const parseNow = new Date();
    const parsedRuntimeTime = parseRouteTime(deterministicRoute.requestedDateTime, { now: parseNow });
    const parsedRequestedMs = otpDateTimeMs(parsedRuntimeTime.date, parsedRuntimeTime.time);
    console.log("[PARSE OUTPUT DEBUG]", {
      originText: deterministicRoute.originText,
      destinationText: deterministicRoute.destinationText,
      rawTimeText: deterministicRoute.time,
      explicitDate: deterministicRoute.explicitDate,
      requestedDateTime: new Date(parsedRequestedMs).toISOString(),
      timeMode: deterministicRoute.timeMode
    });
    logRouteParseDebug(message, deterministicRoute, lang);
    const debugNow = new Date();
    const debugTimeValidation = validateRequestedTime({ requestedDateTime: deterministicRoute.requestedDateTime, explicitDate: deterministicRoute.explicitDate, timeMode: deterministicRoute.timeMode, selectedLanguage: lang, now: debugNow });
    console.log("[MULTILINGUAL PAST TIME DEBUG]", {
      selectedLanguage: lang,
      rawText: message,
      originText: deterministicRoute.originText,
      destinationText: deterministicRoute.destinationText,
      requestedDateTime: deterministicRoute.requestedDateTime,
      now: debugNow,
      isPastTime: debugTimeValidation.status === "past_time",
      nextMode: debugTimeValidation.status === "past_time" ? "awaiting_past_time_choice" : "continue_route_flow"
    });

    const wasInPaymentFlow = ["payment_started", "payment_completed"].includes(session.ticketFlowStatus);
    if (wasInPaymentFlow && messageLooksLikeRouteIntent(message)) {
      clearRouteMemory(session);
      clearTicketFlow(session);
    }

    if (body.useCurrentLocation === true && deterministicRoute.destination) {
      const validation = validateRequestedTime({
        requestedDateTime: deterministicRoute.time,
        explicitDate: deterministicRoute.explicitDate,
        timeMode: deterministicRoute.timeMode,
        selectedLanguage: lang,
        now: new Date()
      });
      if (validation.status === "past_time") {
        clearRouteMemory(session);
        mergeRouteState(session, deterministicRoute, message);
        const clarification = pastTimeClarificationResponse(pastTimeRouteResult(session.route, validation), session, lang);
        rememberMessage(session, "user", message);
        rememberMessage(session, "assistant", clarification.reply);
        sendBotJson(200, { sessionId, ...clarification, routeSummary: "", lastRouteResult: null, memory: memoryPayload(session) });
        return;
      }
    }

    const selectedLocationPayload = selectedPlaceFromPayload(body.selectedLocation)
      ? body.selectedLocation
      : pendingChoiceForMessage(session, message)?.locationSelection;
    if (selectedLocationPayload) {
      const selectedRole = session.pendingLocation?.role
        || (body.locationRole === "start" ? "start" : "")
        || (missingRouteField(session) === "start" ? "start" : "destination");
      const place = applySelectedLocation(session, selectedLocationPayload, selectedRole);
      if (place) {
        const selectedResponse = await responseAfterSelectedLocation({
          session,
          place,
          role: selectedRole,
          message,
          lang
        });
        rememberMessage(session, "user", message);
        rememberMessage(session, "assistant", selectedResponse.reply);
        sendBotJson(200, {
          sessionId,
          reply: selectedResponse.reply,
          quickButtons: selectedResponse.quickButtons,
          routeSummary: selectedResponse.routeResult?.ok ? routeSummaryForDemo(selectedResponse.routeResult, lang) : "",
          lastRouteResult: selectedResponse.routeResult?.ok ? selectedResponse.routeResult : null,
          memory: memoryPayload(session)
        });
        return;
      }
    }

    const routeSelectionPayload = routeSelectionFromPayload(body.routeSelection);
    if (routeSelectionPayload) {
      const routeSelectionResponse = await responseAfterRouteSelection({
        session,
        routeSelection: routeSelectionPayload,
        message,
        lang
      });
      rememberMessage(session, "user", message);
      rememberMessage(session, "assistant", routeSelectionResponse.reply);
      sendBotJson(200, {
        sessionId,
        reply: routeSelectionResponse.reply,
        quickButtons: routeSelectionResponse.quickButtons,
        routeSummary: routeSelectionResponse.routeResult?.ok ? routeSummaryForDemo(routeSelectionResponse.routeResult, lang) : "",
        lastRouteResult: routeSelectionResponse.routeResult?.ok ? routeSelectionResponse.routeResult : null,
        memory: memoryPayload(session)
      });
      return;
    }

    const currentCoords = body.useCurrentLocation === true ? validCoords(body.fromCoords) : null;
    if (currentCoords) {
      const currentResponse = await responseAfterCurrentLocation({
        session,
        coords: currentCoords,
        message,
        lang
      });
      rememberMessage(session, "user", message);
      rememberMessage(session, "assistant", currentResponse.reply);
      sendBotJson(200, {
        sessionId,
        reply: currentResponse.reply,
        quickButtons: currentResponse.quickButtons,
        routeSummary: currentResponse.routeResult?.ok ? routeSummaryForDemo(currentResponse.routeResult, lang) : "",
        lastRouteResult: currentResponse.routeResult?.ok ? currentResponse.routeResult : null,
        memory: memoryPayload(session)
      });
      return;
    }

    if (["awaiting_past_time_choice", "awaiting_different_time"].includes(session.pendingRoute?.mode)) {
      const pendingTimeChoiceResponse = await responseForPendingTimeChoice({
        session,
        message,
        lang
      });
      if (pendingTimeChoiceResponse) {
        rememberMessage(session, "user", message);
        rememberMessage(session, "assistant", pendingTimeChoiceResponse.reply);
        sendBotJson(200, {
          sessionId,
          reply: pendingTimeChoiceResponse.reply,
          quickButtons: pendingTimeChoiceResponse.quickButtons,
          routeSummary: pendingTimeChoiceResponse.routeResult?.ok ? routeSummaryForDemo(pendingTimeChoiceResponse.routeResult, lang) : "",
          lastRouteResult: pendingTimeChoiceResponse.routeResult?.ok ? pendingTimeChoiceResponse.routeResult : null,
          memory: memoryPayload(session)
        });
        return;
      }
    }

    if (session.pendingRoute?.mode === "awaiting_place_correction") {
      const pendingPlaceCorrectionResponse = await responseForPendingPlaceCorrection({
        session,
        message,
        lang
      });
      if (pendingPlaceCorrectionResponse) {
        rememberMessage(session, "user", message);
        rememberMessage(session, "assistant", pendingPlaceCorrectionResponse.reply);
        sendBotJson(200, {
          sessionId,
          reply: pendingPlaceCorrectionResponse.reply,
          quickButtons: pendingPlaceCorrectionResponse.quickButtons,
          routeSummary: pendingPlaceCorrectionResponse.routeResult?.ok ? routeSummaryForDemo(pendingPlaceCorrectionResponse.routeResult, lang) : "",
          lastRouteResult: pendingPlaceCorrectionResponse.routeResult?.ok ? pendingPlaceCorrectionResponse.routeResult : null,
          memory: memoryPayload(session)
        });
        return;
      }
    }

    const pendingMessageStartsNewDestination = isDestinationOnlyRoute(deterministicRoute) && messageMentionsRoute(message);
    if (session.pendingRoute?.mode === "awaiting_origin" && !pendingMessageStartsNewDestination) {
      const pendingOriginResponse = await responseForPendingOrigin({
        session,
        message,
        lang
      });
      if (pendingOriginResponse) {
        rememberMessage(session, "user", message);
        rememberMessage(session, "assistant", pendingOriginResponse.reply);
        sendBotJson(200, {
          sessionId,
          reply: pendingOriginResponse.reply,
          quickButtons: pendingOriginResponse.quickButtons,
          routeSummary: pendingOriginResponse.routeResult?.ok ? routeSummaryForDemo(pendingOriginResponse.routeResult, lang) : "",
          lastRouteResult: pendingOriginResponse.routeResult?.ok ? pendingOriginResponse.routeResult : null,
          memory: memoryPayload(session)
        });
        return;
      }
    }

    if (isDestinationOnlyRoute(deterministicRoute)) {
      const destinationOnlyResponse = await responseForDestinationOnlyRoute({
        session,
        route: deterministicRoute,
        message,
        lang
      });
      rememberMessage(session, "user", message);
      rememberMessage(session, "assistant", destinationOnlyResponse.reply);
      sendBotJson(200, {
        sessionId,
        reply: destinationOnlyResponse.reply,
        quickButtons: destinationOnlyResponse.quickButtons,
        routeSummary: destinationOnlyResponse.routeResult?.ok ? routeSummaryForDemo(destinationOnlyResponse.routeResult, lang) : "",
        lastRouteResult: destinationOnlyResponse.routeResult?.ok ? destinationOnlyResponse.routeResult : null,
        memory: memoryPayload(session)
      });
      return;
    }

    if (isTicketOnlyQuestion(message)) {
      clearRouteMemory(session);
      updateSessionContext(session, newcomerContext(message, lang), {
        context: { needsTicketHelp: true }
      });
      const reply = isDbOrIceTicketQuestion(message)
        ? dbIceTicketMessage(lang)
        : ticketFallbackWithContext(lang, session.context);
      rememberMessage(session, "user", message);
      rememberMessage(session, "assistant", reply);
      sendBotJson(200, {
        sessionId,
        reply,
        quickButtons: ticketQuickButtons(lang),
        memory: memoryPayload(session)
      });
      return;
    }

    if (!(deterministicRoute.start && deterministicRoute.destination)) {
      const standalonePlace = await handleStandalonePlaceMessage(message, lang, session);
      if (standalonePlace) {
        rememberMessage(session, "user", message);
        rememberMessage(session, "assistant", standalonePlace.reply);
        sendBotJson(200, {
          sessionId,
          reply: standalonePlace.reply,
          quickButtons: standalonePlace.quickButtons,
          memory: memoryPayload(session)
        });
        return;
      }
    }

    if (deterministicRoute.start && deterministicRoute.destination) {
      if (isNewRouteRequest(session, deterministicRoute)) {
        clearRouteMemory(session);
      }
      mergeRouteState(session, deterministicRoute, message);
      const routeResult = await planRoute(
        session.route,
        session.route.start === "My current location" ? session.fromCoords : null,
        routeOptionsFromSession(session, arriveByForRoute(deterministicRoute, message), message)
      );
      let reply = routeErrorMessage(routeResult.error, lang, choicesForRouteResult(routeResult));
      let quickButtons = [];

      if (routeResult.ok) {
        session.pendingLocation = null;
        session.pendingRoute = null;
        session.ticketFlowStatus = routeResult.walkRecommended ? "none" : "asking_ticket";
        session.lastRouteResult = routeResult;
        reply = routeReplyForResult(routeResult, message, lang, session.context);
        quickButtons = routeButtonsForResult(routeResult, lang);
      } else if (routeResult.error === "past_time") {
        session.pendingLocation = null;
        const clarification = pastTimeClarificationResponse(routeResult, session, lang);
        reply = clarification.reply;
        quickButtons = clarification.quickButtons;
      } else if (routeResult.error === "place_correction_suggestions") {
        const correctionResponse = responseForPlaceCorrection(session, routeResult, lang);
        reply = correctionResponse.reply;
        quickButtons = correctionResponse.quickButtons;
      } else {
        quickButtons = quickButtonsForChoices(
          routeResult.choices?.length ? routeResult.choices : (routeResult.knownPlaceChoices || [])
        );
        if (routeResult.error === "ambiguous_supported_place" && routeResult.choices?.length) {
          session.pendingLocation = {
            role: routeResult.locationRole || "destination",
            choices: routeResult.choices
          };
        } else if (routeResult.error === "unknown_supported_place" && routeResult.knownPlaceChoices?.length) {
          session.pendingLocation = {
            role: routeResult.locationRole || "destination",
            choices: routeResult.knownPlaceChoices
          };
        }
      }

      rememberMessage(session, "user", message);
      rememberMessage(session, "assistant", reply);
      sendBotJson(200, {
        sessionId,
        reply,
        quickButtons,
        routeSummary: routeResult.ok ? routeSummaryForDemo(routeResult, lang) : "",
        lastRouteResult: routeResult.ok ? routeResult : null,
        memory: memoryPayload(session)
      });
      return;
    }

    if (!hasAiBackend()) {
      sendBotJson(503, {
        sessionId,
        reply: aiBackendSetupMessage(lang),
        quickButtons: []
      });
      return;
    }

    const interpretation = await interpretMessageWithAi(message, lang, session);
    if (isDestinationOnlyRoute(interpretation.route || {})) {
      const destinationOnlyResponse = await responseForDestinationOnlyRoute({
        session,
        route: interpretation.route,
        message,
        lang
      });
      rememberMessage(session, "user", message);
      rememberMessage(session, "assistant", destinationOnlyResponse.reply);
      sendBotJson(200, {
        sessionId,
        reply: destinationOnlyResponse.reply,
        quickButtons: destinationOnlyResponse.quickButtons,
        routeSummary: destinationOnlyResponse.routeResult?.ok ? routeSummaryForDemo(destinationOnlyResponse.routeResult, lang) : "",
        lastRouteResult: destinationOnlyResponse.routeResult?.ok ? destinationOnlyResponse.routeResult : null,
        memory: memoryPayload(session)
      });
      return;
    }
    if (isNewRouteRequest(session, interpretation.route)) {
      clearRouteMemory(session);
    }
    mergeRouteState(session, interpretation.route || {}, message);
    const hasDeterministicRoute = Boolean(deterministicRoute.start || deterministicRoute.destination || deterministicRoute.time);
    if (hasDeterministicRoute) {
      mergeRouteState(session, deterministicRoute, message);
    }
    mergeRouteFallback(session, extractCurrentLocationRouteContext(message));
    applyCurrentLocationDefaults(session, message);

    const fromCoords = body.fromCoords && typeof body.fromCoords === "object" ? body.fromCoords : null;
    const routeStart = cleanRoutePlaceName(deterministicRoute.start || interpretation.route?.start);
    const useCurrentLocation = body.useCurrentLocation === true || routeStart === "My current location";
    if (routeStart && routeStart !== "My current location") {
      if (normalizeText(routeStart) !== normalizeText(session.route.start)) {
        session.selectedLocations.start = null;
      }
      session.route.start = routeStart;
      session.fromCoords = null;
    } else if (fromCoords && useCurrentLocation && (session.route.destination || ["route", "delay", "accessibility"].includes(interpretation.intent))) {
      session.route.start = "My current location";
      session.fromCoords = fromCoords;
    }

    let routeResult = null;
    const missing = missingRouteField(session);
    let reply;
    let quickButtons = [];
    const wantsTicketInfo = interpretation.intent === "ticket" || messageMentionsTickets(message);
    const wantsRouteInfo = interpretation.shouldPlanRoute
      || ["route", "delay", "accessibility"].includes(interpretation.intent)
      || Boolean(deterministicRoute.start && deterministicRoute.destination);
    const arriveBy = arriveByForRoute(session.route, message);
    const userContext = newcomerContext(message, lang);
    updateSessionContext(session, userContext, interpretation);

    if (interpretation.intent === "out_of_scope") {
      reply = interpretation.assistantDraft || ts("outOfScope", lang);
    } else if ((wantsTicketInfo || session.context.needsTicketHelp) && !wantsRouteInfo) {
      reply = ticketFallbackWithContext(lang, session.context);
      quickButtons = ticketQuickButtons(lang);
    } else if (wantsRouteInfo && missing) {
      if (missing === "start" && session.route.destination) {
        rememberPendingDestinationRoute(session, session.route, message, session.selectedLocations?.destination || null);
      }
      quickButtons = quickButtonsForMissing(missing, lang);
      reply = userContext.isConfused || userContext.isNewcomer || session.context.isNewcomer
        ? (
          missing === "start"
            ? ts("noWorriesStart", lang)
            : missing === "destination"
              ? ts("noWorriesDest", lang)
              : ts("noWorriesTime", lang)
        )
    : interpretation.assistantDraft || (
          missing === "start"
            ? ts("sureStart", lang)
            : missing === "destination"
              ? ts("sureDest", lang)
              : ts("sureTime", lang)
        );
      if (wantsTicketInfo || session.context.needsTicketHelp || session.context.isStudent) {
        reply += `\n\n${ticketRouteNote(lang, session.context.isStudent)}`;
        quickButtons.push(...ticketQuickButtons(lang));
      }
    } else if (wantsRouteInfo) {
      const sharedTimeValidation = validateRequestedTime({
        requestedDateTime: session.route.time,
        explicitDate: session.route.explicitDate,
        timeMode: session.route.timeMode,
        selectedLanguage: lang,
        now: new Date()
      });
      if (sharedTimeValidation.status === "past_time") {
        const clarification = pastTimeClarificationResponse(pastTimeRouteResult(session.route, sharedTimeValidation), session, lang);
        reply = clarification.reply;
        quickButtons = clarification.quickButtons;
      } else {
        routeResult = await planRoute(
          session.route,
          session.route.start === "My current location" ? session.fromCoords : null,
          routeOptionsFromSession(session, arriveBy, message)
        );
        if (routeResult.ok) {
          session.pendingLocation = null;
          session.ticketFlowStatus = routeResult.walkRecommended ? "none" : "asking_ticket";
          session.lastRouteResult = routeResult;
          reply = routeReplyForResult(routeResult, message, lang, session.context);
          quickButtons = routeButtonsForResult(routeResult, lang);
        } else if (routeResult.error === "past_time") {
          session.pendingLocation = null;
          const clarification = pastTimeClarificationResponse(routeResult, session, lang);
          reply = clarification.reply;
          quickButtons = clarification.quickButtons;
        } else {
          quickButtons = quickButtonsForChoices(routeResult.choices);
          if (routeResult.error === "ambiguous_supported_place" && routeResult.choices?.length) {
            session.pendingLocation = {
              role: routeResult.locationRole || "destination",
              choices: routeResult.choices
            };
          }
          if (!quickButtons.length && routeResult.error === "unknown_supported_place") {
            const knownChoices = routeResult.knownPlaceChoices || [];
            quickButtons = knownChoices;
            if (knownChoices.length) {
              session.pendingLocation = {
                role: routeResult.locationRole || "destination",
                choices: knownChoices
              };
            }
          }
          reply = routeErrorMessage(routeResult.error, lang, choicesForRouteResult(routeResult));
          if (wantsTicketInfo || session.context.needsTicketHelp || session.context.isStudent) {
            reply += `\n\n${ticketRouteNote(lang, session.context.isStudent)}`;
            quickButtons.push(...ticketQuickButtons(lang));
          }
        }
      }
    } else {
      reply = interpretation.assistantDraft || await composeFinalAnswer({ message, lang, session, interpretation, routeResult: null });
    }

    rememberMessage(session, "user", message);
    rememberMessage(session, "assistant", reply);

    sendBotJson(200, {
      sessionId,
      reply,
      quickButtons,
      routeSummary: routeResult?.ok ? routeSummaryForDemo(routeResult, lang) : "",
      lastRouteResult: routeResult?.ok ? routeResult : null,
      memory: {
        ...memoryPayload(session)
      }
    });
  } catch (error) {
    console.error("[Chat Handler Error]", {
      message: error.message,
      code: error.code,
      status: error.status,
      stack: error.stack
    });
    const isMissingAiConfig = error.message === "missing_openai_api_key" || error.message === "missing_ollama_config";
    const isAiError = error.code === "openai_api_error" || error.code === "ollama_api_error";
    const status = isMissingAiConfig ? 503 : isAiError ? 502 : 500;
    const openAiReply = error.status === 401
      ? ts("openAiAuthError", lang)
      : ts("openAiReplyError", lang);
    const ollamaReply = ts("ollamaReplyError", lang);
    sendBotJson(status, {
      error: "chat_handler_error",
      reply: status === 503
        ? aiBackendSetupMessage(lang)
        : error.code === "ollama_api_error"
          ? ollamaReply
        : error.code === "openai_api_error"
          ? openAiReply
        : ts("safeProcessError", lang)
    });
  }
}

const SERVER_VERSION = "walk-first-runtime-debug-v1";

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(String(req.url || "/").split("?")[0]);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  if (req.method === "POST" && urlPath === "/api/chat") {
    handleChatRequest(req, res);
    return;
  }

  if (req.method === "POST" && urlPath === "/api/clear-session") {
    handleClearSessionRequest(req, res);
    return;
  }

  if (req.method === "POST" && urlPath === "/api/route") {
    handleRouteRequest(req, res);
    return;
  }

  if (req.method === "POST" && urlPath === "/api/segment-alternatives") {
    handleSegmentAlternativesRequest(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }

  const safePath = path.normalize(urlPath).replace(/^([/\\]*\.\.[/\\])+/, "");
  const requestedPath = safePath === "/" ? "index.html" : safePath.replace(/^[/\\]+/, "");
  const filePath = path.join(root, requestedPath);
  const relativePath = path.relative(root, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!publicFiles.has(relativePath)) {
    sendText(res, 404, "Not found");
    return;
  }

  sendFile(req, res, filePath);
});

function getNetworkUrls() {
  const urls = [`http://localhost:${port}`];
  const interfaces = os.networkInterfaces();

  Object.values(interfaces).flat().forEach(details => {
    if (details && details.family === "IPv4" && !details.internal) {
      urls.push(`http://${details.address}:${port}`);
    }
  });

  return urls;
}

if (require.main === module) {
  server.on("error", error => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set PORT to another value and restart.`);
    } else if (error.code === "EACCES" || error.code === "EPERM") {
      console.error(`Cannot listen on ${host}:${port}. Try HOST=127.0.0.1 or a different PORT.`);
    } else {
      console.error("Server failed to start:", error.message);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`[SERVER VERSION] ${SERVER_VERSION}`);
    console.log("[ACTIVE SERVER VERSION] walk-first-runtime-debug-v1", {
      startedAt: new Date().toISOString()
    });
    console.log("Oldenburg Transport Chatbot is running:");
    getNetworkUrls().forEach(url => console.log(`- ${url}`));
  });
}

module.exports = {
  TIME_MODE,
  extractTripDetails,
  normalizeTimeMode,
  inferTimeModeFromText,
  validateRequestedTime,
  aliasQueriesForPlace,
  resolveKnownPlace,
  resolveSupportedLocation,
  hasHouseNumber,
  looksLikeStreetAddress,
  isStrongAddressMatch,
  buildWalkingMapsUrlFromCoords,
  normalizeItinerary,
  normalizePlaceName,
  shouldSuppressFinalWalk,
  haversineMeters,
  logRouteCoordinateDebug,
  assertFirstWalkUsesResolvedOrigin,
  correctPlaceTypos,
  placeQueryResolvesDirectly,
  detectPlaceCorrection,
  planRoute,
  buildWalkingRecommendationRoute,
  shouldPreferTransit,
  detectTransitIntent,
  decideRecommendedMode,
  ts,
  serverStrings,
  handleChatRequest,
  itinerarySatisfiesTimeMode
};
