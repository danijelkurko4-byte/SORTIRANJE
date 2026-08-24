const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'build')));

// TVOJ GRAPHOPPER KLJUČ JE UBACEN
const GH_API_KEY = 'dd881665-eefc-4a92-ba83-016e0ce98484'; 

const ZARADA_FAJL = './zarada.json';
const POCETNA_BAZA = "Centralna radna 4, Nova Pazova, Srbija";

function procitajZaradu() {
    try {
        if (!fs.existsSync(ZARADA_FAJL)) return [];
        return JSON.parse(fs.readFileSync(ZARADA_FAJL));
    } catch (e) { return []; }
}

// 1. Geokodiranje preko GraphHopper-a (Nalaženje ulica)
async function geocode(adresa) {
    try {
        const url = `https://graphhopper.com/api/1/geocode?q=${encodeURIComponent(adresa)}&locale=sr&limit=1&key=${GH_API_KEY}`;
        const res = await axios.get(url);
        if (res.data.hits && res.data.hits.length > 0) {
            const point = res.data.hits[0].point;
            console.log(`✅ Nađeno: ${adresa}`);
            return [point.lng, point.lat]; // GraphHopper koristi [lon, lat]
        }
        return null;
    } catch (e) { return null; }
}

app.post('/api/optimizuj', async (req, res) => {
    try {
        const { adrese, zavrsnaAdresa } = req.body;
        console.log("Započinjem GraphHopper optimizaciju...");

        const startCoords = await geocode(POCETNA_BAZA) || [20.2189, 44.9514];
        const krajCoords = await geocode(zavrsnaAdresa || POCETNA_BAZA) || startCoords;

        let services = [];
        let adresePodaci = [];
        let neuspesneAdrese = [];

        // Geokodiranje svih adresa iz Excela
        for (let i = 0; i < adrese.length; i++) {
            const coords = await geocode(adrese[i]);
            if (coords) {
                const id = `job-${i}`;
                services.push({
                    id: id,
                    address: { location_id: id, lon: coords[0], lat: coords[1] }
                });
                adresePodaci.push({ id: id, adresa: adrese[i], coords: [coords[1], coords[0]] });
            } else {
                neuspesneAdrese.push(adrese[i]);
            }
            // GraphHopper dozvoljava brz tempo, 150ms pauze je dovoljno
            await new Promise(r => setTimeout(r, 150));
        }

        if (services.length === 0) return res.status(400).json({ error: "Nijedna adresa nije nađena." });

        // 2. GraphHopper Route Optimization (VRP)
        const ghVrpBody = {
            vehicles: [{
                vehicle_id: "kurir-vozilo",
                start_address: { location_id: "start", lon: startCoords[0], lat: startCoords[1] },
                end_address: { location_id: "end", lon: krajCoords[0], lat: krajCoords[1] },
                type_id: "car",
                profile: "car"
            }],
            services: services
        };

        const ghRes = await axios.post(`https://graphhopper.com/api/1/vrp/optimize?key=${GH_API_KEY}`, ghVrpBody);
        
        if (!ghRes.data.solution) throw new Error("Nema rešenja rute.");

        const activities = ghRes.data.solution.routes[0].activities;
        
        // Mapiranje sortiranih rezultata
        const sortirano = activities
            .filter(act => act.type === "service")
            .map(act => {
                const podaci = adresePodaci.find(p => p.id === act.id);
                return { adresa: podaci.adresa, coords: podaci.coords, isporuceno: false };
            });

        // 3. Iscrtavanje linije puta (Road Geometry)
        let putanjaPoUlicama = [];
        try {
            const tackeZaPut = [
                [startCoords[1], startCoords[0]], 
                ...sortirano.map(s => s.coords), 
                [krajCoords[1], krajCoords[0]]
            ];
            
            const pointsQuery = tackeZaPut.map(p => `point=${p[0]},${p[1]}`).join('&');
            const routeUrl = `https://graphhopper.com/api/1/route?key=${GH_API_KEY}&type=json&points_encoded=false&profile=car&${pointsQuery}`;
            
            const routeRes = await axios.get(routeUrl);
            putanjaPoUlicama = routeRes.data.paths[0].points.coordinates.map(c => [c[1], c[0]]);
        } catch (e) {
            console.log("Fallback na vazdušnu liniju.");
            putanjaPoUlicama = sortirano.map(s => s.coords);
        }

        res.json({ 
            sortirano, 
            putanjaPoUlicama, 
            neuspesneAdrese, 
            startCoords: [startCoords[1], startCoords[0]], 
            krajCoords: [krajCoords[1], krajCoords[0]] 
        });

    } catch (error) {
        console.error("Greška:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Problem sa GraphHopper API-jem." });
    }
});

// Ostale rute (Zarada, Statistika)
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

app.use((req, res) => res.sendFile(path.join(__dirname, 'build', 'index.html')));

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => console.log(`GraphHopper Server aktivan na portu ${PORT}`));