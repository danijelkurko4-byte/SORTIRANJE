const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'build')));

const ZARADA_FAJL = './zarada.json';
const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImRiMzFiZjE4NjZkZTRiMWE5MmUzNjgxZDdjMzRhZGViIiwiaCI6Im11cm11cjY0In0='; 
const POCETNA_BAZA = "Centralna radna 4, Nova Pazova, Srbija";

function procitajZaradu() {
    try {
        if (!fs.existsSync(ZARADA_FAJL)) return [];
        return JSON.parse(fs.readFileSync(ZARADA_FAJL));
    } catch (e) { return []; }
}

async function geocode(adresa) {
    try {
        const query = adresa.toLowerCase().includes("srbija") ? adresa : `${adresa}, Srbija`;
        const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(query)}&boundary.country=RS&size=1`;
        const res = await axios.get(url);
        if (res.data && res.data.features && res.data.features.length > 0) {
            return res.data.features[0].geometry.coordinates;
        }
        return null;
    } catch (e) { return null; }
}

app.post('/api/optimizuj', async (req, res) => {
    try {
        const { adrese, zavrsnaAdresa } = req.body;
        let startCoords = await geocode(POCETNA_BAZA) || [20.2189, 44.9514];
        let krajCoords = await geocode(zavrsnaAdresa || POCETNA_BAZA) || startCoords;

        let validneTacke = [];
        let adresePodaci = [];
        let neuspesneAdrese = [];

        for (let adr of adrese) {
            const coords = await geocode(adr);
            if (coords) {
                validneTacke.push(coords);
                adresePodaci.push({ adresa: adr, coords: [coords[1], coords[0]] });
            } else {
                neuspesneAdrese.push(adr);
            }
            await new Promise(r => setTimeout(r, 600));
        }

        if (validneTacke.length === 0) return res.status(400).json({ error: "Nijedna adresa nije nađena." });

        const optRes = await axios.post('https://api.openrouteservice.org/optimization', {
            jobs: validneTacke.map((coords, i) => ({ id: i, location: coords })),
            vehicles: [{ id: 1, profile: 'driving-car', start: startCoords, end: krajCoords }]
        }, { headers: { 'Authorization': ORS_API_KEY } });

        const steps = optRes.data.routes[0].steps;
        const sortirano = steps.filter(s => s.type === 'job').map(s => ({
            adresa: adresePodaci[s.id].adresa,
            coords: adresePodaci[s.id].coords,
            isporuceno: false
        }));

        let putanjaPoUlicama = [];
        try {
            let siroveK = [startCoords, ...steps.filter(s => s.type === 'job').map(s => validneTacke[s.id]), krajCoords];
            let cisteK = siroveK.filter((c, i, self) => i === 0 || (c[0] !== self[i-1][0] || c[1] !== self[i-1][1]));
            const dirRes = await axios.post('https://api.openrouteservice.org/v2/directions/driving-car/geojson', { coordinates: cisteK }, { headers: { 'Authorization': ORS_API_KEY } });
            putanjaPoUlicama = dirRes.data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
        } catch (e) { putanjaPoUlicama = sortirano.map(z => z.coords); }

        res.json({ sortirano, putanjaPoUlicama, neuspesneAdrese, startCoords: [startCoords[1], startCoords[0]], krajCoords: [krajCoords[1], krajCoords[0]] });
    } catch (error) { res.status(500).json({ error: "Greška na serveru" }); }
});

app.post('/api/sacuvaj-dan', (req, res) => {
    try {
        const { broj_isporuka, ukupna_suma } = req.body;
        const danas = new Date().toISOString().split('T')[0];
        let podaci = procitajZaradu();
        podaci = podaci.filter(p => p.datum !== danas);
        podaci.push({ datum: danas, broj_isporuka, ukupna_suma });
        fs.writeFileSync(ZARADA_FAJL, JSON.stringify(podaci, null, 2));
        res.json({ message: "OK" });
    } catch (e) { res.status(500).json({ error: "Greška" }); }
});

app.get('/api/statistika', (req, res) => {
    try {
        let podaci = procitajZaradu();
        const stat = podaci.reduce((acc, curr) => {
            acc.total_isporuka += curr.broj_isporuka;
            acc.total_suma += curr.ukupna_suma;
            return acc;
        }, { total_isporuka: 0, total_suma: 0 });
        res.json(stat);
    } catch (e) { res.json({ total_isporuka: 0, total_suma: 0 }); }
});

// POPRAVLJENO ZA RENDER (Wildcard route)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`SERVER SPREMAN NA PORTU ${PORT}`));