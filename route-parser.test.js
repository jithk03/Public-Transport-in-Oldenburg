const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");
const {
  TIME_MODE,
  extractTripDetails,
  validateRequestedTime,
  aliasQueriesForPlace,
  resolveKnownPlace,
  resolveSupportedLocation,
  hasHouseNumber,
  looksLikeStreetAddress,
  isStrongAddressMatch,
  normalizeItinerary,
  shouldSuppressFinalWalk,
  haversineMeters,
  logRouteCoordinateDebug,
  correctPlaceTypos,
  detectPlaceCorrection,
  planRoute,
  buildWalkingRecommendationRoute,
  shouldPreferTransit,
  detectTransitIntent,
  decideRecommendedMode,
  ts,
  handleChatRequest,
  itinerarySatisfiesTimeMode
} = require("./server");

const fixedBerlinNow = new Date("2026-06-22T16:14:00.000Z"); // 18:14 Europe/Berlin

async function sendChatMessage(payload) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = "POST";
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = chunk => {
    if (chunk) chunks.push(Buffer.from(chunk));
    res.emit("finish");
  };

  await new Promise(resolve => {
    res.on("finish", resolve);
    handleChatRequest(req, res);
  });

  return {
    status: res.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
  };
}

function deadlineMsFromRouteResult(routeResult) {
  const [month, day, year] = String(routeResult.query.deadlineDate || routeResult.query.otpDate || "").split("-");
  const time = String(routeResult.query.deadlineTime || routeResult.query.otpTime || "00:00:00");
  return Date.parse(`${year}-${month}-${day}T${time}+02:00`);
}

test("explicit tomorrow arrival request keeps its date and arrival deadline", () => {
  const parsed = extractTripDetails("tomorrow i have to be there in lappan at 8 am from postenweg 20", "en");

  assert.equal(parsed.originText, "postenweg 20");
  assert.match(parsed.destinationText, /Lappan/i);
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
  assert.equal(validateRequestedTime({
    requestedDateTime: parsed.requestedDateTime,
    explicitDate: parsed.explicitDate,
    timeMode: parsed.timeMode,
    selectedLanguage: "en",
    now: new Date("2026-06-22T17:24:00.000Z")
  }).status, "ok");
});

test("destination-only 'be there' request is parsed as ARRIVE_BY", () => {
  const parsed = extractTripDetails("i want to be there in lappan at 8:30 am tomorrow", "en");

  assert.equal(parsed.originText, null);
  assert.match(parsed.destinationText, /Lappan/i);
  assert.equal(parsed.requestedDateTime, "tomorrow 8:30 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("explicit today arrival request warns when its clock time has passed", () => {
  const parsed = extractTripDetails("today i have to be there in lappan at 8 am from postenweg 20", "en");

  assert.equal(parsed.explicitDate, "today");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
  assert.equal(validateRequestedTime({
    requestedDateTime: parsed.requestedDateTime,
    explicitDate: parsed.explicitDate,
    timeMode: parsed.timeMode,
    selectedLanguage: "en",
    now: new Date("2026-06-22T17:24:00.000Z") // 19:24 Europe/Berlin
  }).status, "past_time");
});

test("explicit tomorrow departure request remains DEPART_AT", () => {
  const parsed = extractTripDetails("tomorrow i want to go to lappan at 8 am from postenweg 20", "en");

  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("destination and tomorrow time without origin asks for origin before time validation", async () => {
  const response = await sendChatMessage({
    sessionId: "missing-origin-before-time-validation",
    selectedLanguage: "en",
    message: "I want to go to Stadt Oldenburg tomorrow at 8 am"
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reply, "Where are you starting from?");
  assert.doesNotMatch(response.body.reply, /already passed/i);
  assert.equal(response.body.memory.route.destination, "Stadt Oldenburg");
  assert.equal(response.body.memory.route.time, "8:00 AM");
  assert.equal(response.body.memory.route.explicitDate, "tomorrow");
  assert.equal(response.body.memory.pendingRoute.mode, "awaiting_origin");
});

test("pending destination route merges a from-origin follow-up without losing tomorrow time", async () => {
  const sessionId = "pending-origin-follow-up";
  await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I want to go to Stadt Oldenburg tomorrow at 8 am"
  });

  const response = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "from Schützenweg"
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body.reply, /Where are you starting from\?/);
  assert.doesNotMatch(response.body.reply, /already passed/i);
  assert.equal(response.body.memory.route.start, "Schützenweg");
  assert.equal(response.body.memory.route.destination, "Stadt Oldenburg");
  assert.equal(response.body.memory.route.time, "8:00 AM");
  assert.equal(response.body.memory.route.explicitDate, "tomorrow");
});

test("complete Stadt Oldenburg tomorrow request keeps origin, destination, and tomorrow time", () => {
  const parsed = extractTripDetails("I want to go to Stadt Oldenburg tomorrow at 8 am from Schützenweg", "en");

  assert.equal(parsed.originText, "Schützenweg");
  assert.equal(parsed.destinationText, "Stadt Oldenburg");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("common tomorrow typo is normalized in complete route requests", () => {
  const parsed = extractTripDetails("I want to go to Stadt Oldenburg tomorow at 8 am from Schützenweg", "en");

  assert.equal(parsed.originText, "Schützenweg");
  assert.equal(parsed.destinationText, "Stadt Oldenburg");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(validateRequestedTime({
    requestedDateTime: parsed.requestedDateTime,
    explicitDate: parsed.explicitDate,
    timeMode: parsed.timeMode,
    selectedLanguage: "en",
    now: new Date("2026-06-22T17:24:00.000Z")
  }).status, "ok");
});

test("12pm and 12am preserve noon, midnight, destination-only state, and ARRIVE_BY", () => {
  const noon = extractTripDetails("i want to be in stadt oldenburg at 12pm tomorrow", "en");
  assert.equal(noon.originText, null);
  assert.equal(noon.destinationText, "stadt oldenburg");
  assert.equal(noon.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(noon.explicitDate, "tomorrow");
  assert.equal(noon.timeMode, TIME_MODE.ARRIVE_BY);

  const midnight = extractTripDetails("i want to be in stadt oldenburg at 12am tomorrow", "en");
  assert.equal(midnight.originText, null);
  assert.equal(midnight.requestedDateTime, "tomorrow 12:00 AM");
  assert.equal(midnight.timeMode, TIME_MODE.ARRIVE_BY);

  const departure = extractTripDetails("i want to go to stadt oldenburg at 12pm tomorrow", "en");
  assert.equal(departure.originText, null);
  assert.equal(departure.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(departure.timeMode, TIME_MODE.DEPART_AT);
});

test("destination arrival with an explicit origin keeps noon and ARRIVE_BY", () => {
  const parsed = extractTripDetails("i want to be in stadt oldenburg at 12pm tomorrow from postenweg 20", "en");
  assert.equal(parsed.originText, "postenweg 20");
  assert.equal(parsed.destinationText, "stadt oldenburg");
  assert.equal(parsed.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("need to arrive by is parsed as an explicit tomorrow arrival deadline", () => {
  const parsed = extractTripDetails("tomorrow i need to arrive at lappan by 8 am from postenweg 20", "en");

  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("supported languages preserve tomorrow and ARRIVE_BY", () => {
  const cases = [
    ["de", "Ich muss morgen um 8 Uhr am Lappan sein von Postenweg 20"],
    ["hi", "मुझे कल सुबह 8 बजे लप्पन पहुँचना है, Postenweg 20 से"],
    ["ar", "يجب أن أكون في لابان غدًا الساعة 8 صباحًا من Postenweg 20"],
    ["uk", "Завтра я маю бути в Лаппані о 8 ранку з Postenweg 20"],
    ["tr", "Yarın saat 8'de Lappan'da olmam gerekiyor, Postenweg 20'den"]
  ];

  for (const [lang, input] of cases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(parsed.originText, "Postenweg 20", lang);
    assert.equal(parsed.destinationText, "Lappan", lang);
    assert.equal(parsed.requestedDateTime, "tomorrow 8:00", lang);
    assert.equal(parsed.explicitDate, "tomorrow", lang);
    assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY, lang);
  }
});

test("ARRIVE_BY itinerary guard rejects arrivals after the requested deadline", () => {
  const deadline = Date.parse("2026-06-23T06:00:00.000Z");
  assert.equal(itinerarySatisfiesTimeMode({ endTime: deadline - 2 * 60000 }, deadline, TIME_MODE.ARRIVE_BY), true);
  assert.equal(itinerarySatisfiesTimeMode({ endTime: deadline + 17 * 60000 }, deadline, TIME_MODE.ARRIVE_BY), false);
  assert.equal(itinerarySatisfiesTimeMode({ endTime: deadline + 17 * 60000 }, deadline, TIME_MODE.DEPART_AT), true);
});

const multilingualPastTimeCases = [
  ["en", "I want to go to Lappan at 6pm today", "Lappan", 18],
  ["de", "Ich möchte heute um 18 Uhr zum Lappan fahren", "Lappan", 18],
  ["ar", "أريد الذهاب إلى لابان اليوم الساعة 6 مساءً", "Lappan", 18],
  ["hi", "मैं आज शाम 6 बजे लप्पन जाना चाहता हूँ", "Lappan", 18],
  ["uk", "Я хочу поїхати до Лаппан сьогодні о 18:00", "Lappan", 18],
  ["tr", "Bugün saat 18:00'de Lappan'a gitmek istiyorum", "Lappan", 18]
];

test("shared multilingual parser emits one language-neutral route shape", () => {
  for (const [lang, input, destination, hour] of multilingualPastTimeCases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(parsed.originText, null, lang);
    assert.match(parsed.destinationText, new RegExp(destination, "i"), lang);
    assert.match(parsed.requestedDateTime, new RegExp(`(?:${hour}:00|6:00 PM)`, "i"), lang);
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT, lang);
    assert.equal(parsed.selectedLanguage, lang, lang);
  }
});

test("one shared validator rejects past times for every supported language", () => {
  for (const [lang, input] of multilingualPastTimeCases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(validateRequestedTime({
      requestedDateTime: parsed.requestedDateTime,
      timeMode: parsed.timeMode,
      selectedLanguage: parsed.selectedLanguage,
      now: fixedBerlinNow
    }).status, "past_time", lang);
  }
});

test("shared validator accepts multilingual future times", () => {
  const cases = [
    ["en", "I want to go to Lappan at 8pm today"],
    ["de", "Ich möchte heute um 20 Uhr zum Lappan fahren"],
    ["ar", "أريد الذهاب إلى لابان اليوم الساعة 8 مساءً"],
    ["hi", "मैं आज रात 8 बजे लप्पन जाना चाहता हूँ"],
    ["uk", "Я хочу поїхати до Лаппан сьогодні о 20:00"]
  ];
  for (const [lang, input] of cases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(validateRequestedTime({ requestedDateTime: parsed.requestedDateTime, timeMode: parsed.timeMode, selectedLanguage: lang, now: fixedBerlinNow }).status, "ok", lang);
  }
});

function assertParsedRoute(input, expected, selectedLanguage = "en") {
  const parsed = extractTripDetails(input, selectedLanguage);

  assert.deepEqual({
    originText: parsed.start,
    destinationText: parsed.destination,
    requestedDateTime: parsed.time,
    timeMode: parsed.timeMode
  }, expected);
}

test("multilingual German arrival route", () => {
  assertParsedRoute("Ich möchte um 12 Uhr von der Salbeistraße aus am Lappan sein – gib mir die Route.", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "de");
});

test("multilingual Arabic arrival route with bracketed Latin place names", () => {
  assertParsedRoute("أريد الوصول إلى لابان (Lappan) عند الساعة 12 ظهرًا انطلاقًا من شارع سالبيشتراسه (Salbeistraße)؛ زوّدني بالمسار.", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "ar");
});

test("multilingual Hindi arrival route with bracketed Latin place names", () => {
  assertParsedRoute("मुझे दोपहर 12 बजे साल्बेस्ट्रासे (Salbeistraße) से लैपन (Lappan) पहुँचना है, कृपया मुझे रास्ता बताएं।", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "hi");
});

test("multilingual Arabic arrival route with inline Latin place names", () => {
  assertParsedRoute("أريد الوصول إلى Lappan عند الساعة 12 من Salbeistraße", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "ar");
});

test("multilingual Arabic departure route with inline Latin place names", () => {
  assertParsedRoute("أريد الانطلاق الساعة 12 من Salbeistraße إلى Lappan", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.DEPART_AT
  }, "ar");
});

test("multilingual Hindi arrival route with inline Latin place names", () => {
  assertParsedRoute("मुझे 12 बजे Salbeistraße से Lappan पहुँचना है", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "hi");
});

test("multilingual Hindi departure route with inline Latin place names", () => {
  assertParsedRoute("मैं 12 बजे Salbeistraße से Lappan जाना चाहता हूँ", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.DEPART_AT
  }, "hi");
});

test("multilingual Ukrainian arrival route", () => {
  assertParsedRoute("Я хочу бути в Lappan о 12:00 із Salbeistraße", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "uk");
});

test("multilingual Ukrainian departure route", () => {
  assertParsedRoute("Я хочу вирушити о 12:00 із Salbeistraße до Lappan", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.DEPART_AT
  }, "uk");
});

test("English arrival route from request", () => {
  assertParsedRoute("I want to be at Lappan at 12pm from Salbeistraße.", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "en");
});

test("English departure route from request", () => {
  assertParsedRoute("I want to start at 12pm from Salbeistraße to reach Lappan.", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  }, "en");
});

test("arrival intent: want to be on Lappan at 12pm from Salbeistraße", () => {
  assertParsedRoute("I want to be on Lappan at 12pm from Salbeistraße. Give me the route.", {
    originText: "Salbeistraße",
    destinationText: "Lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  });
});

test("departure intent: want to go to Lappan at 12pm from Salbeistraße", () => {
  const parsed = extractTripDetails("I want to go to Lappan at 12pm from Salbeistraße.");

  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("arrival intent: need to be at university by 9am from Lappan", () => {
  const parsed = extractTripDetails("I need to be at university by 9am from Lappan.");

  assert.equal(parsed.start, "Lappan");
  assert.equal(parsed.destination, "university");
  assert.equal(parsed.time, "9:00 AM");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("departure intent: start at time from origin to reach destination", () => {
  assertParsedRoute("i want to start at 12pm from salbeistraße to reach lappan", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: start from origin at time to reach destination", () => {
  assertParsedRoute("start from salbeistraße at 12pm to reach lappan", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: leave origin at time and reach destination", () => {
  assertParsedRoute("leave salbeistraße at 12pm and reach lappan", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: depart at time from origin to destination", () => {
  assertParsedRoute("depart at 12pm from salbeistraße to lappan", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: from origin to destination at time", () => {
  assertParsedRoute("from salbeistraße to lappan at 12pm", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("arrival intent still works with at", () => {
  assertParsedRoute("i want to be on lappan at 12pm from salbeistraße", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  });
});

test("arrival intent still works with by", () => {
  assertParsedRoute("i need to be at lappan by 12pm from salbeistraße", {
    originText: "salbeistraße",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  });
});

test("departure intent keeps house number out of time and destination fields", () => {
  assertParsedRoute("i want to go to lappan at 2pm from salbeistraße 24", {
    originText: "salbeistraße 24",
    destinationText: "lappan",
    requestedDateTime: "2:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("street-to-street go-to form treats the first address as origin", () => {
  const parsed = extractTripDetails("i want to go to salbeistraße 24 to postenweg 20 now", "en");
  assert.equal(parsed.originText, "salbeistraße 24");
  assert.equal(parsed.destinationText, "postenweg 20");
  assert.equal(parsed.requestedDateTime, "now");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("go-to place pairs parse both campuses, including Haarentor typo", () => {
  for (const origin of ["uni campus harentor", "uni campus haarentor"]) {
    const parsed = extractTripDetails(`i want to go to ${origin} to uni campus wechloy now`, "en");
    assert.equal(parsed.originText, origin);
    assert.equal(parsed.destinationText, "uni campus wechloy");
    assert.equal(parsed.requestedDateTime, "now");
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
  }
});

test("go-to place pairs parse known stop aliases", () => {
  const parsed = extractTripDetails("i want to go to lappan to pferdemarkt now", "en");
  assert.equal(parsed.originText, "lappan");
  assert.equal(parsed.destinationText, "pferdemarkt");
  assert.equal(parsed.requestedDateTime, "now");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("street-to-street parser supports from and bare address forms", () => {
  for (const input of [
    "i want to go from salbeistraße 24 to postenweg 20 now",
    "from salbeistraße 24 to postenweg 20",
    "salbeistraße 24 to postenweg 20"
  ]) {
    const parsed = extractTripDetails(input, "en");
    assert.equal(parsed.originText, "salbeistraße 24", input);
    assert.equal(parsed.destinationText, "postenweg 20", input);
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT, input);
  }
});

test("destination-only go-to forms remain destination-only", () => {
  for (const [input, destination] of [
    ["i want to go to lappan now", /lappan/i],
    ["i want to go to uni campus haarentor now", /uni campus haarentor/i]
  ]) {
    const parsed = extractTripDetails(input, "en");
    assert.equal(parsed.originText, null, input);
    assert.match(parsed.destinationText, destination, input);
  }
});

test("numbered street addresses require an exact address match, never a stop fallback", () => {
  const exact = {
    name: "Postenweg 20, Oldenburg",
    lat: 53.1434849,
    lon: 8.1728689,
    area: "Oldenburg",
    type: "address",
    address: { road: "Postenweg", house_number: "20", city: "Oldenburg" }
  };
  const stop = {
    name: "Oldenburg(Oldb) Postenweg",
    lat: 53.140881,
    lon: 8.171573,
    area: "Oldenburg",
    type: "stop",
    address: {}
  };

  assert.equal(hasHouseNumber("postenweg 20"), true);
  assert.equal(looksLikeStreetAddress("postenweg 20"), true);
  assert.equal(looksLikeStreetAddress("postenweg"), false);
  assert.equal(isStrongAddressMatch(exact, "postenweg 20"), true);
  assert.equal(isStrongAddressMatch({ ...exact, address: { ...exact.address, house_number: "21" } }, "postenweg 20"), false);
  assert.equal(isStrongAddressMatch(stop, "postenweg 20"), false);
});

test("alias regression resolves lappan and salbeistraße 24 variants", () => {
  const lappanAlias = aliasQueriesForPlace("lappan")[0];
  const salbeiAlias = aliasQueriesForPlace("salbeistraße 24")[0];
  const salbeiTypoAlias = aliasQueriesForPlace("salbeisraße 24")[0];

  assert.equal(resolveKnownPlace(lappanAlias, { exactOnly: true }).name, "Oldenburg(Oldb) Lappan");
  assert.equal(resolveKnownPlace(salbeiAlias, { exactOnly: true }).name, "Salbeistraße 24, Oldenburg");
  assert.equal(resolveKnownPlace(salbeiTypoAlias, { exactOnly: true }).name, "Salbeistraße 24, Oldenburg");
});

test("resolvePlace regression keeps salbeistraße 24 off Hamelmannstraße", async () => {
  const resolution = await resolveSupportedLocation("salbeistraße 24");

  assert.equal(resolution.ok, true);
  assert.match(resolution.place.name, /Salbeistraße/);
  assert.doesNotMatch(resolution.place.name, /Hamelmannstraße/);
});

function mapsOriginCoords(mapsUrl) {
  const url = new URL(mapsUrl);
  const [lat, lon] = url.searchParams.get("origin").split(",").map(Number);
  return { lat, lon };
}

test("walking map regression starts first WALK leg at resolved origin coordinates", () => {
  const salbeistrasse24 = { name: "Salbeistraße 24, Oldenburg", lat: 53.1466, lon: 8.1918 };
  const lappan = { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 };
  const hamelmannstrasseLikeCoords = { lat: 53.1483, lon: 8.1841 };
  const stopCoords = { lat: 53.1472, lon: 8.1901 };
  const itinerary = normalizeItinerary({
    duration: 600,
    startTime: 1000,
    endTime: 2000,
    legs: [
      {
        mode: "WALK",
        distance: 120,
        from: { name: "Hamelmannstraße", ...hamelmannstrasseLikeCoords },
        to: { name: "Nearest stop", ...stopCoords },
        startTime: 1000,
        endTime: 1100
      },
      {
        mode: "BUS",
        transitLeg: true,
        from: { name: "Nearest stop", ...stopCoords },
        to: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        startTime: 1100,
        endTime: 2000
      }
    ]
  }, {
    requestedOrigin: salbeistrasse24,
    requestedDestination: lappan
  });

  const firstWalk = itinerary.legs[0];
  assert.deepEqual(firstWalk.fromCoords, { lat: 53.1466, lon: 8.1918 });
  assert.equal(firstWalk.from.name, "Salbeistraße 24, Oldenburg");
  assert.match(firstWalk.mapsUrl, /origin=53\.1466,8\.1918/);
  assert.doesNotMatch(firstWalk.mapsUrl, /origin=53\.1483,8\.1841/);
});

test("walking URL regression for salbeistraße 24 to lappan proves first origin", () => {
  const input = "i want to go to lappan at 2pm from salbeistraße 24";
  const details = extractTripDetails(input);
  const salbeistrasse24 = { name: "Salbeistraße 24, Oldenburg", label: "Salbeistraße 24, Oldenburg", lat: 53.1466, lon: 8.1918 };
  const lappan = { name: "Oldenburg(Oldb) Lappan", label: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 };
  const hamelmannstrasseCoords = { lat: 53.1483, lon: 8.1841 };
  const firstStop = { name: "Oldenburg(Oldb) Kath. Friedhof/BBS Haarentor", lat: 53.1472, lon: 8.1901 };
  const itinerary = normalizeItinerary({
    duration: 1800,
    startTime: 1000,
    endTime: 2800,
    legs: [
      {
        mode: "WALK",
        distance: 391,
        from: { name: "Hamelmannstraße", ...hamelmannstrasseCoords },
        to: firstStop,
        startTime: 1000,
        endTime: 1360
      },
      {
        mode: "BUS",
        transitLeg: true,
        routeShortName: "S35",
        from: firstStop,
        to: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        startTime: 1400,
        endTime: 2500
      },
      {
        mode: "WALK",
        distance: 318,
        from: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        to: { name: "Wrong snapped destination", lat: 53.1419, lon: 8.2168 },
        startTime: 2500,
        endTime: 2800
      }
    ]
  }, {
    requestedOrigin: salbeistrasse24,
    requestedDestination: lappan
  });

  const firstWalkLeg = itinerary.legs.find(leg => leg.mode === "WALK");
  const originCoords = mapsOriginCoords(firstWalkLeg.mapsUrl);
  const originDistance = haversineMeters(salbeistrasse24.lat, salbeistrasse24.lon, originCoords.lat, originCoords.lon);
  const hamelmannDistance = haversineMeters(hamelmannstrasseCoords.lat, hamelmannstrasseCoords.lon, originCoords.lat, originCoords.lon);

  assert.equal(details.start, "salbeistraße 24");
  assert.equal(details.destination, "lappan");
  assert.equal(details.time, "2:00 PM");
  assert.equal(firstWalkLeg.from.name, "Salbeistraße 24, Oldenburg");
  assert.ok(originDistance <= 80);
  assert.ok(hamelmannDistance > 80);
  assert.doesNotMatch(firstWalkLeg.mapsUrl, /53\.1483,8\.1841/);
});

test("final walk regression suppresses Lappan stop to Lappan destination", () => {
  const postenweg20 = { name: "Postenweg 20, Oldenburg", label: "Postenweg 20, Oldenburg", lat: 53.1408, lon: 8.1711 };
  const lappan = {
    rawText: "lappan",
    name: "Oldenburg(Oldb) Lappan",
    label: "Oldenburg(Oldb) Lappan",
    stopId: "1:000009000995",
    lat: 53.14332,
    lon: 8.214339
  };
  const postenwegStop = { name: "Oldenburg(Oldb) Postenweg", stopId: "1:000009090219", lat: 53.140881, lon: 8.171573 };
  const lappanStop = { name: "Oldenburg(Oldb) Lappan", stopId: "1:000009000995", lat: 53.14332, lon: 8.214339 };
  const itinerary = normalizeItinerary({
    duration: 1200,
    startTime: 1000,
    endTime: 2200,
    legs: [
      {
        mode: "WALK",
        distance: 80,
        from: postenweg20,
        to: postenwegStop,
        startTime: 1000,
        endTime: 1060
      },
      {
        mode: "BUS",
        transitLeg: true,
        routeShortName: "309",
        from: postenwegStop,
        to: lappanStop,
        startTime: 1100,
        endTime: 1900
      },
      {
        mode: "WALK",
        distance: 318,
        from: lappanStop,
        to: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        startTime: 1900,
        endTime: 2200
      }
    ]
  }, {
    requestedOrigin: postenweg20,
    requestedDestination: lappan
  });

  assert.equal(itinerary.suppressedFinalWalk.shouldSuppressFinalWalk, true);
  assert.equal(itinerary.suppressedFinalWalk.stopIdsMatch, true);
  assert.equal(itinerary.suppressedFinalWalk.namesMatch, true);
  assert.equal(itinerary.suppressedFinalWalk.finalWalkDistance, 318);
  assert.equal(itinerary.legs.filter(leg => leg.mode === "WALK").length, 1);
  assert.equal(itinerary.legs.at(-1).mode, "BUS");
  assert.doesNotMatch(JSON.stringify(itinerary), /origin=53\.14332,8\.214339&destination=53\.1409,8\.2138/);
});

test("final walk regression keeps real POI walk near Lappan", () => {
  const lappanStop = { name: "Oldenburg(Oldb) Lappan", stopId: "1:000009000995", lat: 53.14332, lon: 8.214339 };
  const pferdemarktPoi = {
    rawText: "pferdemarkt",
    name: "Oldenburg(Oldb) Pferdemarkt",
    label: "Oldenburg(Oldb) Pferdemarkt",
    stopId: "1:000009000881",
    lat: 53.146771,
    lon: 8.214682
  };

  assert.equal(shouldSuppressFinalWalk(lappanStop, pferdemarktPoi, {
    distanceMeters: 385,
    from: lappanStop,
    to: pferdemarktPoi
  }), false);
});

test("final walk label translation key exists for required languages", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /walkFromStopToDestination:\s*"from \{from\} to \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"von \{from\} nach \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"من \{from\} إلى \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"від \{from\} до \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"\{from\} से \{to\} तक"/);
});

test("route coordinate debug emits required salbeistraße values", () => {
  const input = "i want to go to lappan at 2pm from salbeistraße 24";
  const details = extractTripDetails(input);
  const resolvedOrigin = { name: "Salbeistraße 24, Oldenburg", label: "Salbeistraße 24, Oldenburg", lat: 53.1466, lon: 8.1918 };
  const resolvedDestination = { name: "Oldenburg(Oldb) Lappan", label: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 };
  const route = {
    legs: [
      {
        mode: "WALK",
        from: { name: "Salbeistraße 24, Oldenburg", lat: 53.1466, lon: 8.1918 },
        to: { name: "Oldenburg(Oldb) Kath. Friedhof/BBS Haarentor", lat: 53.1472, lon: 8.1901 },
        fromCoords: { lat: 53.1466, lon: 8.1918 },
        toCoords: { lat: 53.1472, lon: 8.1901 },
        mapsUrl: "https://www.google.com/maps/dir/?api=1&origin=53.1466,8.1918&destination=53.1472,8.1901&travelmode=walking"
      }
    ]
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (label, payload) => logs.push({ label, payload });
  try {
    logRouteCoordinateDebug({ rawText: input, details, resolvedOrigin, resolvedDestination, route });
  } finally {
    console.log = originalLog;
  }

  const routeRequest = logs.find(log => log.label === "[ROUTE REQUEST DEBUG]").payload;
  const resolvedPlaces = logs.find(log => log.label === "[RESOLVED PLACES DEBUG]").payload;
  const firstWalk = logs.find(log => log.label === "[FIRST WALK LEG DEBUG]").payload;

  assert.deepEqual(routeRequest, {
    rawText: input,
    originText: "salbeistraße 24",
    destinationText: "lappan",
    requestedDateTime: "2:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
  assert.equal(resolvedPlaces.originLabel, "Salbeistraße 24, Oldenburg");
  assert.equal(resolvedPlaces.destinationLabel, "Oldenburg(Oldb) Lappan");
  assert.equal(firstWalk.fromLat, 53.1466);
  assert.equal(firstWalk.fromLon, 8.1918);
  assert.match(firstWalk.mapsUrl, /origin=53\.1466,8\.1918/);
  assert.doesNotMatch(JSON.stringify(logs), /Hamelmannstraße/);
});

test("raw-message UI code adds the user message only once", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const userBubbleAdds = [...html.matchAll(/addMessage\(text,\s*"user"/g)];

  assert.equal(userBubbleAdds.length, 1);
  assert.doesNotMatch(html, /addMessage\([^)]*(?:normalized|translated|corrected)[^)]*,\s*"user"/i);
});

test("Arabic UI has RTL support", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /dir:\s*"rtl"/);
  assert.match(html, /\[dir="rtl"\]/);
});

// --- Typo-tolerant place search ----------------------------------------

test("Test1 parsing: 'i want to travel from posternweg to Pfedermarkt now'", () => {
  assertParsedRoute("i want to travel from posternweg to Pfedermarkt now", {
    originText: "posternweg",
    destinationText: "Pfedermarkt",
    requestedDateTime: "now",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("Test2 parsing: 'from lapan to hauptbanhof'", () => {
  assertParsedRoute("from lapan to hauptbanhof", {
    originText: "lapan",
    destinationText: "hauptbanhof",
    requestedDateTime: "now",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("Test3 parsing: 'from salbeisraße 24 to lappan'", () => {
  assertParsedRoute("from salbeisraße 24 to lappan", {
    originText: "salbeisraße 24",
    destinationText: "lappan",
    requestedDateTime: "now",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("correctPlaceTypos fixes all known misspellings", () => {
  assert.deepEqual(correctPlaceTypos("posternweg"), { corrected: true, text: "postenweg" });
  assert.deepEqual(correctPlaceTypos("Pfedermarkt"), { corrected: true, text: "pferdemarkt" });
  assert.deepEqual(correctPlaceTypos("salbeisraße"), { corrected: true, text: "salbeistrasse" });
  assert.deepEqual(correctPlaceTypos("salbeisrasse"), { corrected: true, text: "salbeistrasse" });
  assert.deepEqual(correctPlaceTypos("lapan"), { corrected: true, text: "lappan" });
  assert.deepEqual(correctPlaceTypos("hauptbanhof"), { corrected: true, text: "hauptbahnhof" });
});

test("detectPlaceCorrection resolves misspelled places to known stops", () => {
  assert.equal(detectPlaceCorrection("posternweg").place.name, "Oldenburg(Oldb) Postenweg");
  assert.equal(detectPlaceCorrection("Pfedermarkt").place.name, "Oldenburg(Oldb) Pferdemarkt");
  assert.equal(detectPlaceCorrection("lapan").place.name, "Oldenburg(Oldb) Lappan");
  assert.equal(detectPlaceCorrection("hauptbanhof").place.name, "Oldenburg Hauptbahnhof");
  assert.equal(detectPlaceCorrection("posternweg").confidence, "high");
});

test("detectPlaceCorrection leaves correctly spelled places alone", () => {
  assert.equal(detectPlaceCorrection("lappan"), null);
  assert.equal(detectPlaceCorrection("salbeistraße 24"), null);
  assert.equal(detectPlaceCorrection("salbeisraße 24"), null);
  assert.equal(detectPlaceCorrection("postenweg"), null);
  assert.equal(detectPlaceCorrection("pferdemarkt"), null);
  assert.equal(detectPlaceCorrection("hauptbahnhof"), null);
});

test("planRoute Test1: both sides typo'd suggests Postenweg -> Pferdemarkt", async () => {
  const details = extractTripDetails("i want to travel from posternweg to Pfedermarkt now", "en");
  const result = await planRoute(details);

  assert.equal(result.ok, false);
  assert.equal(result.error, "place_correction_suggestions");
  assert.equal(result.correction.origin.place.name, "Oldenburg(Oldb) Postenweg");
  assert.equal(result.correction.destination.place.name, "Oldenburg(Oldb) Pferdemarkt");
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].label, "Oldenburg(Oldb) Postenweg → Oldenburg(Oldb) Pferdemarkt");
  assert.equal(result.suggestions[0].origin.stopId, "1:000009090219");
  assert.ok(Number.isFinite(result.suggestions[0].origin.lat));
  assert.ok(Number.isFinite(result.suggestions[0].destination.lat));
  assert.equal(result.pendingRoute.originText, "posternweg");
  assert.equal(result.pendingRoute.destinationText, "Pfedermarkt");
});

test("planRoute Test2: 'from lapan to hauptbanhof' suggests Lappan -> Hauptbahnhof", async () => {
  const details = extractTripDetails("from lapan to hauptbanhof", "en");
  const result = await planRoute(details);

  assert.equal(result.ok, false);
  assert.equal(result.error, "place_correction_suggestions");
  assert.equal(result.correction.origin.place.name, "Oldenburg(Oldb) Lappan");
  assert.equal(result.correction.destination.place.name, "Oldenburg Hauptbahnhof");
  assert.equal(result.suggestions[0].label, "Oldenburg(Oldb) Lappan → Oldenburg Hauptbahnhof");
});

test("translations: didYouMeanPlace and usingCorrectedPlaces substitute params in all languages", () => {
  for (const lang of ["en", "de", "ar", "tr", "uk", "hi"]) {
    const didYouMean = ts("didYouMeanPlace", lang, { original: "Pfedermarkt", place: "Pferdemarkt" });
    assert.match(didYouMean, /Pfedermarkt/);
    assert.match(didYouMean, /Pferdemarkt/);
    assert.doesNotMatch(didYouMean, /\{original\}|\{place\}/);

    const usingPlaces = ts("usingCorrectedPlaces", lang, { origin: "Postenweg", destination: "Pferdemarkt" });
    assert.match(usingPlaces, /Postenweg/);
    assert.match(usingPlaces, /Pferdemarkt/);
    assert.doesNotMatch(usingPlaces, /\{origin\}|\{destination\}/);

    assert.ok(ts("didYouMeanThesePlaces", lang));
    assert.ok(ts("useThesePlaces", lang));
    assert.ok(ts("enterDifferentPlaces", lang));
    assert.ok(ts("enterAnotherOrigin", lang));
    assert.ok(ts("enterAnotherDestination", lang));
  }
});

test("index.html chip handling supports routeSelection payloads", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /item\.routeSelection/);
  assert.match(html, /storedItem\.routeSelection/);
  assert.match(html, /routeSelection:\s*storedItem\.routeSelection/);
});

// --- End-to-end chat flow -----------------------------------------------

function startTestServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => handleChatRequest(req, res));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function postChat(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

test("end-to-end: both-side typo route offers a single-click suggestion that plans the route", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "i want to travel from posternweg to Pfedermarkt now",
      selectedLanguage: "en"
    });

    // Must not show a dead-end "could not find this place" message.
    assert.doesNotMatch(first.reply, /could not find this place/i);
    assert.equal(first.reply, ts("didYouMeanThesePlaces", "en"));

    const suggestion = first.quickButtons.find(button => button.routeSelection);
    assert.ok(suggestion, "expected a routeSelection suggestion button");
    assert.equal(suggestion.label, "Oldenburg(Oldb) Postenweg → Oldenburg(Oldb) Pferdemarkt");

    const second = await postChat(baseUrl, {
      message: suggestion.value,
      selectedLanguage: "en",
      sessionId: first.sessionId,
      routeSelection: suggestion.routeSelection
    });

    assert.match(second.reply, /Postenweg/);
    assert.match(second.reply, /Pferdemarkt/);
    assert.ok(second.routeSummary, "expected a computed route summary");
  } finally {
    server.close();
  }
});

test("end-to-end: 'Enter different places' clears the pending correction", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "i want to travel from posternweg to Pfedermarkt now",
      selectedLanguage: "en"
    });

    const enterDifferent = ts("enterDifferentPlaces", "en");
    const second = await postChat(baseUrl, {
      message: enterDifferent,
      selectedLanguage: "en",
      sessionId: first.sessionId
    });

    assert.equal(second.reply, ts("askRouteOrigin", "en"));
  } finally {
    server.close();
  }
});

test("end-to-end: single-side typo asks about only that place, in the selected language", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "from posternweg to lappan",
      selectedLanguage: "ar"
    });

    assert.equal(response.reply, ts("didYouMeanPlace", "ar", {
      original: "posternweg",
      place: "Oldenburg(Oldb) Postenweg"
    }));

    const suggestion = response.quickButtons.find(button => button.locationSelection);
    assert.ok(suggestion, "expected a locationSelection suggestion button");
    assert.equal(suggestion.locationSelection.name, "Oldenburg(Oldb) Postenweg");
  } finally {
    server.close();
  }
});

test("end-to-end: destination-only query asks for starting point and shows location choice buttons", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "I want to go to Lappan",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /Lappan/i);
    assert.match(response.reply, /starting point/i);

    const locationBtn = response.quickButtons.find(b => b.value === "__current_location__");
    assert.ok(locationBtn, "expected a 'Use my current location' button");
    assert.equal(locationBtn.label, ts("useCurrentLoc", "en"));

    const manualBtn = response.quickButtons.find(b => b.value === "__type_location_manually__");
    assert.ok(manualBtn, "expected an 'Enter location manually' button");
    assert.equal(manualBtn.label, ts("typeLocManually", "en"));
  } finally {
    server.close();
  }
});

test("end-to-end: ambiguous noon destination selection preserves ARRIVE_BY and still asks for origin", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const previous = await postChat(baseUrl, {
      message: "from postenweg to lappan now",
      selectedLanguage: "en"
    });
    assert.match(previous.memory.route.start, /postenweg/i);

    const first = await postChat(baseUrl, {
      message: "i want to be in stadt oldenburg at 12pm tomorrow",
      selectedLanguage: "en",
      sessionId: previous.sessionId
    });

    const buergerbuero = first.quickButtons.find(button => /Bürgerbüro Oldenburg/i.test(button.label || ""));
    assert.ok(buergerbuero?.locationSelection, "expected Bürgerbüro destination choice");
    assert.equal(first.memory.route.start, "");
    assert.equal(first.memory.route.time, "tomorrow 12:00 PM");
    assert.equal(first.memory.route.timeMode, TIME_MODE.ARRIVE_BY);

    const second = await postChat(baseUrl, {
      message: buergerbuero.value,
      selectedLanguage: "en",
      sessionId: first.sessionId,
      selectedLocation: buergerbuero.locationSelection,
      locationRole: "destination"
    });

    assert.match(second.reply, /starting point/i);
    assert.equal(second.lastRouteResult, null);
    assert.equal(second.routeSummary, "");
    assert.equal(second.memory.route.start, "");
    assert.equal(second.memory.route.destination, "Bürgerbüro Oldenburg");
    assert.equal(second.memory.route.time, "tomorrow 12:00 PM");
    assert.equal(second.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
    assert.ok(second.quickButtons.some(button => button.value === "__current_location__"));
    assert.ok(second.quickButtons.some(button => button.value === "__type_location_manually__"));

    const third = await postChat(baseUrl, {
      message: "postenweg 20",
      selectedLanguage: "en",
      sessionId: first.sessionId
    });
    assert.equal(third.memory.route.start, "postenweg 20");
    assert.equal(third.memory.route.time, "tomorrow 12:00 PM");
    assert.equal(third.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
    if (third.lastRouteResult) {
      assert.equal(third.lastRouteResult.query.arriveBy, true);
      assert.ok(third.lastRouteResult.route.endTime <= deadlineMsFromRouteResult(third.lastRouteResult));
      assert.doesNotMatch(third.routeSummary, /12:09 AM|12:29 AM/i);
    }
  } finally {
    server.close();
  }
});

test("end-to-end: pending origin preserves tomorrow ARRIVE_BY deadline", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "i want to be there in lappan at 8:30 am tomorrow",
      selectedLanguage: "en"
    });

    assert.match(first.reply, /starting point/i);
    assert.equal(first.memory.pendingRoute.mode, "awaiting_origin");
    assert.equal(first.memory.pendingRoute.requestedDateTime.toLowerCase(), "tomorrow 8:30 am");
    assert.equal(first.memory.pendingRoute.explicitDate, "tomorrow");
    assert.equal(first.memory.pendingRoute.timeMode, TIME_MODE.ARRIVE_BY);

    const second = await postChat(baseUrl, {
      message: "postenweg 20",
      selectedLanguage: "en",
      sessionId: first.sessionId
    });

    assert.equal(second.memory.route.time.toLowerCase(), "tomorrow 8:30 am");
    assert.equal(second.memory.route.explicitDate, "tomorrow");
    assert.equal(second.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
    if (second.lastRouteResult) {
      assert.equal(second.lastRouteResult.query.arriveBy, true);
      assert.ok(second.lastRouteResult.route.endTime <= deadlineMsFromRouteResult(second.lastRouteResult));
      assert.doesNotMatch(second.reply, /Leave 8:30 AM\s*·\s*Arrive after 8:30 AM/i);
    }
  } finally {
    server.close();
  }
});

test("end-to-end: destination-only then geolocation coords plans the route without re-asking for origin", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "I want to go to Lappan",
      selectedLanguage: "en"
    });

    assert.ok(first.sessionId, "expected a session ID");
    assert.match(first.reply, /Lappan/i);

    const second = await postChat(baseUrl, {
      message: "Use my current location",
      selectedLanguage: "en",
      sessionId: first.sessionId,
      useCurrentLocation: true,
      fromCoords: { lat: 53.1466, lon: 8.1918 }
    });

    assert.doesNotMatch(second.reply, /starting point/i);
    assert.doesNotMatch(second.reply, /starting from/i);
  } finally {
    server.close();
  }
});

// --- Walk-leg labeling correctness -----------------------------------------

test("normalizeItinerary: first WALK leg before BUS uses boarding stop as 'to', not the final destination", () => {
  const itinerary = {
    duration: 780,
    startTime: 1700000000000,
    endTime: 1700000780000,
    legs: [
      {
        mode: "WALK",
        distance: 331,
        startTime: 1700000000000,
        endTime: 1700000300000,
        from: { name: "Salbeistraße 24, Oldenburg", lat: 53.1466, lon: 8.1918 },
        to:   { name: "Oldenburg(Oldb) Postenweg",  lat: 53.1472, lon: 8.1901 }
      },
      {
        mode: "BUS",
        routeShortName: "309",
        startTime: 1700000300000,
        endTime: 1700001020000,
        from: { name: "Oldenburg(Oldb) Postenweg", lat: 53.1472, lon: 8.1901 },
        to:   { name: "Oldenburg(Oldb) Lappan",    lat: 53.1409, lon: 8.2138 }
      }
    ]
  };

  const routeCoords = {
    requestedOrigin:      { name: "Salbeistraße 24, Oldenburg", lat: 53.1466, lon: 8.1918 },
    requestedDestination: { name: "Oldenburg(Oldb) Lappan",     lat: 53.1409, lon: 8.2138 },
    originLabel:      "Salbeistraße 24, Oldenburg",
    destinationLabel: "Oldenburg(Oldb) Lappan"
  };

  const result = normalizeItinerary(itinerary, routeCoords);
  const walkLeg = result.legs.find(l => l.mode === "WALK");

  assert.ok(walkLeg, "expected a WALK leg");
  // The walk ends at the BUS boarding stop, not the final destination
  assert.equal(walkLeg.to.name, "Oldenburg(Oldb) Postenweg",
    "first WALK leg must lead to the boarding stop, not the final destination");
  assert.notEqual(walkLeg.to.name, "Oldenburg(Oldb) Lappan",
    "first WALK leg must NOT use requestedDestination as its 'to'");
  // The Maps URL must go to Postenweg coords, not Lappan coords
  assert.match(walkLeg.mapsUrl, /destination=53\.1472,8\.1901/,
    "walk mapsUrl must target boarding stop coordinates");
});

test("normalizeItinerary: final WALK leg after BUS still uses requestedDestination as 'to'", () => {
  const itinerary = {
    duration: 1080,
    startTime: 1700000000000,
    endTime: 1700001080000,
    legs: [
      {
        mode: "BUS",
        routeShortName: "309",
        startTime: 1700000000000,
        endTime: 1700000780000,
        from: { name: "Oldenburg(Oldb) Postenweg", lat: 53.1472, lon: 8.1901 },
        to:   { name: "Oldenburg(Oldb) Lappan",    lat: 53.1409, lon: 8.2138 }
      },
      {
        mode: "WALK",
        distance: 150,
        startTime: 1700000780000,
        endTime: 1700001080000,
        from: { name: "Oldenburg(Oldb) Lappan",  lat: 53.1409, lon: 8.2138 },
        to:   { name: "Lappan Building Entrance", lat: 53.1405, lon: 8.2140 }
      }
    ]
  };

  const routeCoords = {
    requestedOrigin:      { name: "Oldenburg(Oldb) Postenweg", lat: 53.1472, lon: 8.1901 },
    requestedDestination: { name: "Lappan Building Entrance",  lat: 53.1405, lon: 8.2140 },
    originLabel:      "Oldenburg(Oldb) Postenweg",
    destinationLabel: "Lappan Building Entrance"
  };

  const result = normalizeItinerary(itinerary, routeCoords);
  const walkLeg = result.legs.find(l => l.mode === "WALK");

  assert.ok(walkLeg, "expected a WALK leg");
  // The final walk leads to the actual requested destination
  assert.equal(walkLeg.to.name, "Lappan Building Entrance",
    "final WALK leg (after transit) must use requestedDestination as its 'to'");
  assert.equal(walkLeg.from.name, "Oldenburg(Oldb) Lappan",
    "final WALK leg must start at the last transit alighting stop");
  assert.match(walkLeg.mapsUrl, /origin=53\.1409,8\.2138&destination=53\.1405,8\.214/);
});

test("normalizeItinerary fixes both outer walks from neighboring transit endpoints", () => {
  const requestedOrigin = { name: "Origin Address", lat: 53.1, lon: 8.1 };
  const requestedDestination = { name: "Bürgerbüro Oldenburg", lat: 53.15, lon: 8.25 };
  const result = normalizeItinerary({
    legs: [
      { mode: "WALK", distance: 300, from: requestedDestination, to: requestedDestination },
      { mode: "BUS", from: { name: "Boarding Stop", lat: 53.11, lon: 8.11 }, to: { name: "Lappan", lat: 53.14, lon: 8.21 } },
      { mode: "WALK", distance: 450, from: requestedOrigin, to: requestedOrigin }
    ]
  }, { requestedOrigin, requestedDestination });

  const walks = result.legs.filter(leg => leg.mode === "WALK");
  assert.equal(walks[0].from.name, "Origin Address");
  assert.equal(walks[0].to.name, "Boarding Stop");
  assert.match(walks[0].mapsUrl, /origin=53\.1,8\.1&destination=53\.11,8\.11/);
  assert.equal(walks[1].from.name, "Lappan");
  assert.equal(walks[1].to.name, "Bürgerbüro Oldenburg");
  assert.match(walks[1].mapsUrl, /origin=53\.14,8\.21&destination=53\.15,8\.25/);
});

test("normalizeItinerary fixes transfer walk to adjacent transit stops", () => {
  const result = normalizeItinerary({
    legs: [
      { mode: "BUS", from: { name: "A", lat: 53.1, lon: 8.1 }, to: { name: "Transfer Alight", lat: 53.2, lon: 8.2 } },
      { mode: "WALK", distance: 200, from: { name: "Wrong From", lat: 1, lon: 1 }, to: { name: "Wrong To", lat: 2, lon: 2 } },
      { mode: "TRAIN", from: { name: "Transfer Board", lat: 53.21, lon: 8.22 }, to: { name: "B", lat: 53.3, lon: 8.3 } }
    ]
  }, {
    requestedOrigin: { name: "Origin", lat: 53, lon: 8 },
    requestedDestination: { name: "Destination", lat: 54, lon: 9 }
  });

  const walk = result.legs.find(leg => leg.mode === "WALK");
  assert.equal(walk.from.name, "Transfer Alight");
  assert.equal(walk.to.name, "Transfer Board");
  assert.match(walk.mapsUrl, /origin=53\.2,8\.2&destination=53\.21,8\.22/);
});

test("normalizeItinerary fixes a pure walking route to requested endpoints", () => {
  const result = normalizeItinerary({
    legs: [{ mode: "WALK", distance: 500, from: { name: "Wrong", lat: 1, lon: 1 }, to: { name: "Wrong", lat: 2, lon: 2 } }]
  }, {
    requestedOrigin: { name: "Origin", lat: 53.1, lon: 8.1 },
    requestedDestination: { name: "Destination", lat: 53.2, lon: 8.2 }
  });

  const walk = result.legs[0];
  assert.equal(walk.from.name, "Origin");
  assert.equal(walk.to.name, "Destination");
  assert.match(walk.mapsUrl, /origin=53\.1,8\.1&destination=53\.2,8\.2/);
});

test("nearby route is represented as walk-first with transit retained as an alternative", () => {
  const origin = { name: "Salbeistraße 24, Oldenburg", lat: 53.1427, lon: 8.1732 };
  const destination = { name: "Universität Oldenburg, Campus Haarentor", lat: 53.1479, lon: 8.1837 };
  const transit = { legs: [{ mode: "BUS", route: "309" }], transfers: 0 };
  const result = buildWalkingRecommendationRoute({
    start: origin.name,
    destination: destination.name,
    time: "tomorrow 10:00 AM",
    timeMode: TIME_MODE.DEPART_AT
  }, origin, destination, { date: "06-23-2026", time: "10:00:00" }, {
    transitAlternatives: [transit]
  });

  assert.equal(result.type, "walk-first-route");
  assert.equal(result.recommendedMode, "WALK");
  assert.equal(result.walk.estimatedWalkMinutes, 12);
  assert.ok(result.walk.distanceMeters <= 960);
  assert.match(result.walk.mapsUrl, /origin=53\.1427,8\.1732&destination=53\.1479,8\.1837&travelmode=walking/);
  assert.equal(result.transitAlternative, transit);
  assert.equal(result.alternatives[0], transit);
});

test("explicit transit and walking-avoidance intent override walk-first in supported languages", () => {
  [
    "I want to take a bus",
    "public transport route",
    "I cannot walk much",
    "wheelchair route",
    "mit dem Bus",
    "لا أستطيع المشي",
    "सार्वजनिक परिवहन",
    "не можу ходити",
    "toplu taşıma"
  ].forEach(message => assert.equal(shouldPreferTransit(message), true, message));
  assert.equal(shouldPreferTransit("from Salbeistraße 24 to uni campus haarentor"), false);
});

test("walk-first labels exist in every supported UI language", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.equal((html.match(/recommendedWalk:/g) || []).length, 6);
  assert.equal((html.match(/easiestShortTrip:/g) || []).length, 6);
  assert.equal((html.match(/walkingIsEasiest:/g) || []).length, 6);
  assert.equal((html.match(/aboutMinutes:/g) || []).length, 6);
  assert.equal((html.match(/aroundMeters:/g) || []).length, 6);
  assert.equal((html.match(/publicTransportOption:/g) || []).length, 6);
  assert.equal((html.match(/youCanAlsoTakePublicTransport:/g) || []).length, 6);
});

test("shared walkability decision is language-neutral for all supported languages", () => {
  const ordinaryRequests = {
    en: "i want to go to uni campus haarentor tomorrow at 10 am from postenweg 20",
    de: "Ich möchte morgen um 10 Uhr von Postenweg 20 zum Uni Campus Haarentor",
    ar: "أريد الذهاب إلى Uni Campus Haarentor غدًا الساعة 10 من Postenweg 20",
    hi: "मैं कल सुबह 10 बजे Postenweg 20 से Uni Campus Haarentor जाना चाहता हूँ",
    uk: "Я хочу завтра о 10 поїхати з Postenweg 20 до Uni Campus Haarentor",
    tr: "Yarın saat 10'da Postenweg 20'den Uni Campus Haarentor'a gitmek istiyorum"
  };

  for (const [selectedLanguage, rawText] of Object.entries(ordinaryRequests)) {
    assert.equal(detectTransitIntent(rawText, selectedLanguage).requested, false, selectedLanguage);
    assert.deepEqual(decideRecommendedMode({
      rawText,
      selectedLanguage,
      distanceMeters: 560,
      estimatedWalkMinutes: 7
    }).recommendedMode, "WALK", selectedLanguage);
  }
});

test("shared walkability decision honors explicit transit intent in all supported languages", () => {
  const transitRequests = {
    en: "i want to take a bus to uni campus haarentor from postenweg 20",
    de: "Ich möchte mit dem Bus von Postenweg 20 zum Uni Campus Haarentor fahren",
    ar: "أريد الذهاب بالحافلة من Postenweg 20 إلى Uni Campus Haarentor",
    hi: "मैं Postenweg 20 से Uni Campus Haarentor बस से जाना चाहता हूँ",
    uk: "Я хочу поїхати автобусом з Postenweg 20 до Uni Campus Haarentor",
    tr: "Postenweg 20'den Uni Campus Haarentor'a otobüsle gitmek istiyorum"
  };

  for (const [selectedLanguage, rawText] of Object.entries(transitRequests)) {
    assert.equal(detectTransitIntent(rawText, selectedLanguage).requested, true, selectedLanguage);
    const decision = decideRecommendedMode({ rawText, selectedLanguage, distanceMeters: 560, estimatedWalkMinutes: 7 });
    assert.equal(decision.recommendedMode, "TRANSIT", selectedLanguage);
    assert.equal(decision.reason, "user_requested_transit", selectedLanguage);
  }
});

test("campus aliases resolve to places rather than transit stops", () => {
  for (const query of ["uni campus haarentor", "uni campus harrentor", "campus haarrentor", "campus haarentor", "uni campus wechloy", "campus wechloy"]) {
    const place = resolveKnownPlace(query, { exactOnly: true });
    assert.ok(place, query);
    assert.equal(Boolean(place.stopId), false, query);
    assert.match(place.name, /Campus (?:Haarentor|Wechloy)/i, query);
  }
});

test("exact harrentor runtime input parses the campus and applies the shared threshold decision", () => {
  const rawText = "i want to go to uni campus harrentor from postenweg now";
  const parsed = extractTripDetails(rawText, "en");
  const origin = resolveKnownPlace(parsed.start, { exactOnly: true });
  const destination = resolveKnownPlace(parsed.destination, { exactOnly: true });
  const distanceMeters = Math.round(haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon));
  const estimatedWalkMinutes = Math.ceil(distanceMeters / 80);
  const decision = decideRecommendedMode({ rawText, selectedLanguage: "en", distanceMeters, estimatedWalkMinutes });

  assert.equal(parsed.start, "postenweg");
  assert.match(parsed.destination, /campus Haarentor/i);
  assert.equal(detectTransitIntent(rawText, "en").requested, false);
  assert.equal(distanceMeters, 1124);
  assert.equal(estimatedWalkMinutes, 15);
  assert.equal(decision.isWalkable, distanceMeters <= 900 || estimatedWalkMinutes <= 12);
  if (decision.isWalkable) assert.equal(decision.recommendedMode, "WALK");
});
