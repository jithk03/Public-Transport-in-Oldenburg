# Oldenburg And Bremen Multilingual Transport Chatbot

This is a web-based multilingual AI chatbot for public transport in Oldenburg and Bremen.
The frontend talks only to the local backend. The backend can use Ollama or OpenAI for natural-language chat, keeps conversation memory per browser session, and calls the VBN OTP API for route planning, departure and arrival times, delays, cancellations, and available accessibility fields.

The chatbot is designed for newcomers: international students, exchange students, new residents, tourists, and people who may not know German stop names or the local ticket system. It accepts natural descriptions such as "I just arrived at Oldenburg station and want to go to my student dorm", remembers useful context such as student/newcomer/ticket status, asks one simple follow-up when information is missing, and gives short step-by-step travel guidance. After a successful route, it can also open the resolved trip in external map apps for visual support.

## AI And API Setup

Secrets and model settings must stay on the server. Do not put `OPENAI_API_KEY` or `VBN_OTP_API_KEY` in `index.html` or frontend JavaScript.

1. Install Ollama and pull the local model:

```bash
ollama pull llama3.1:8b
```

2. Copy `.env.example` to `.env`.
3. Keep these Ollama settings in `.env`:

```text
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
```

4. Request a free VBN OTP API key from VBN by emailing `api@vbn.de` with a short description of your project.
   VBN developer information: https://www.vbn.de/service/entwicklerinfos/opendata-und-openservice
5. Add the VBN key to `.env`.

OpenAI is optional. If `OLLAMA_BASE_URL` and `OLLAMA_MODEL` are set, the server uses Ollama first. If they are blank, it falls back to `OPENAI_API_KEY`.

The server loads `.env` automatically on startup. You can also export variables in your shell; exported variables override `.env`.

The simplest local command after filling `.env` is:

```bash
npm start
```

The VBN OTP example sends the key in the `Authorization` header. By default this app sends the raw key:

```text
Authorization: your-api-key
```

If VBN asks you to use the Bearer variant, set:

```text
VBN_OTP_AUTH_SCHEME=Bearer
```

Optional environment variables:

```text
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
OLLAMA_TIMEOUT_MS=60000
OPENAI_API_KEY=replace-me
OPENAI_MODEL=gpt-4.1-mini
PORT=3000
HOST=0.0.0.0
VBN_OTP_API_BASE=http://gtfsr.vbn.de/api
VBN_OTP_ROUTER_ID=connect
VBN_OTP_AUTH_SCHEME=
OPENAI_TIMEOUT_MS=20000
VBN_OTP_TIMEOUT_MS=12000
GEOCODER_BASE_URL=https://nominatim.openstreetmap.org/search
GEOCODER_TIMEOUT_MS=12000
GEOCODER_USER_AGENT=oldenburg-transport-chatbot/1.0
```

## Run The Web App

1. Open this project folder in VS Code.
2. Make sure Node.js is installed.
3. Make sure Ollama is running, then start the app:

```bash
npm start
```

4. Open the app in your browser:

```text
http://localhost:3000
```

The main chatbot UI is in `index.html`. The `server.js` file serves the app, exposes `/api/chat`, stores in-memory session context, calls Ollama or OpenAI, and calls VBN OTP.

**After editing `server.js`, restart `node server.js` manually** (stop the running process and start it again). This server does not hot-reload, so a running process keeps executing the old code until it is restarted.

## Demo Instructions

For a realistic demo, configure `.env`, start Ollama, start the app with `npm start`, and ask:

```text
I have just arrived Oldenburg railway station. I am new to Oldenburg. I want to go Schützenweg Studentenwohnheim Oldenburg. I do not have a ticket. I am a student.
```

The expected answer should feel like a local helper: welcome the user, explain when to leave, where to walk, which line to take, where to get off, show up to two alternatives, warn about delays/cancellations when OTP exposes them, and ask whether the user already has a valid ticket for the trip. The mock ticket flow is a prototype only and does not invent official prices.

## Example Questions

```text
Postenweg
I want to go to University of Oldenburg at 9:00am. I have a meeting.
From Oldenburg Hauptbahnhof to Universität Oldenburg at 9:00
Von Oldenburg Hauptbahnhof zur Universität Oldenburg um 9:00
From Postenweg to Universität Oldenburg at 9:00
From Bremen Hauptbahnhof to Universität Bremen at 9:00
Bremen Domsheide
Bremen Marktplatz
Oldenburg Hauptbahnhof
Universität Oldenburg
Innenstadt
Wechloy
Eversten
Is the route wheelchair accessible?
Which ticket do I need?
```

The AI extracts the start, destination, and time from natural language. If information is missing, it asks a short follow-up question. For streets, addresses, districts, landmarks, and stop names, the backend checks known aliases, searches VBN/GTFS stops by name, geocodes the place, then looks up nearby VBN/OTP stops. If several good matches are found, the bot shows 2-4 choices. Once the route fields are complete, the backend calls:

```text
GET http://gtfsr.vbn.de/api/routers/connect/plan
```

The request uses the VBN OTP `connect` router, `MM-DD-YYYY` dates, coordinates in `lat,lon` format, `WALK,TRANSIT` mode, and the server-side `Authorization` header.

The VBN OTP response is normalized for the chatbot. Raw technical fields are kept on the backend and are not shown to users. User-facing route replies use newcomer-friendly conversational steps:

```text
Leave your location at 12:21.
Walk about 4 minutes to the stop "Postenweg".
Take Bus 309 at 12:25 from "Postenweg" towards Oldenburg ZOB. Get off at "Oldenburg ZOB" at 12:41.
After you get off, walk about 3 minutes to your destination.
Arrive around 12:43.
No transfer is required.

Other options
• Bus 310 — arrives 12:50

Buttons
Buy Ticket
Ticket Information
Open in Maps
```

Routes are ranked by fewer transfers, cancellations/disruptions, useful arrival time, walking distance, delay, and total duration.

## Map Support

The chatbot remains the primary guide. It gives the complete route in conversational steps inside the chat. Successful route replies include a simple ticket-readiness question:

```text
Do you already have a valid ticket for this trip?

Yes, I have a ticket
No, I need a ticket
I am not sure
```

If the user chooses `No, I need a ticket`, the chatbot shows ticket options. Selecting a ticket type immediately opens `mock-payment.html` in a new tab with the selected ticket and route summary, without unloading the chatbot page. If the new tab is blocked, the app shows the same mock payment flow in an in-app modal. The payment page is a mock prototype for HCI demonstration only and does not purchase real tickets.

`Open in Maps` uses only the resolved route origin and destination coordinates. It does not expose API keys. Google Maps uses `travelmode=transit` for public transport routes and `travelmode=walking` for walking-only routes.

## Current Location Support

When the starting point is missing, the chatbot offers:

```text
Use my current location
Type location manually
```

`Use my current location` asks for browser geolocation permission with `navigator.geolocation.getCurrentPosition()`. If permission is granted, the frontend sends `fromCoords` to the backend, the backend sets the route start to `My current location`, looks up nearby VBN stops, and continues route planning. If permission is denied or unavailable, the chatbot asks the user to type a nearby street, stop, landmark, or building name instead.

## Backend Endpoints

```text
POST /api/chat
```

The frontend sends `message`, `lang`, `sessionId`, and optionally `fromCoords` for current-location routing. The backend returns a natural reply, quick buttons when useful, and the session id.

```text
POST /api/route
```

This lower-level endpoint is kept for route lookup testing. The chatbot UI uses `/api/chat`.

## Location Focus

The current resolver focuses on Oldenburg and Bremen and recognizes common places such as:

```text
Oldenburg Hauptbahnhof
Universität Oldenburg / Campus Haarentor
Campus Wechloy
Oldenburg ZOB
Schlossplatz
Pferdemarkt
Julius-Mosen-Platz
Lappan
Eversten
Kreyenbrück
Bremen Hauptbahnhof
Universität Bremen
Bremen Domsheide
Bremen Marktplatz
Bremen Viertel
Bremen Neustadt
```

The AI prompt keeps the assistant focused on public transport in Oldenburg and Bremen. Unknown places receive a safe fallback instead of broad, unfocused requests.

## Fallbacks

Tickets: OTP does not provide ticket prices or purchase information. The chatbot includes a mock ticket purchase flow only for HCI usability demonstration. It does not support real ticket purchase or fare calculation, and `mock-payment.html` clearly warns: "Prototype for academic evaluation. No real payment is processed."

Accessibility: Route responses show wheelchair boarding data where OTP exposes GTFS stop wheelchair fields. If the field is unknown, the chatbot asks users to confirm accessibility with VBN/VWG before travelling.

API errors: If the VBN OTP API is unavailable, returns an error, or the API key is missing, the chatbot shows a friendly error message instead of exposing technical details or secrets.
