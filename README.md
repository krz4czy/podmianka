# Podmianka

Podmiana twarzy w przeglądarce. Zdjęcie źródłowe, zdjęcie albo krótki film, przycisk „Podmień”. Da się też opisać scenę tekstem: darmowy generator rysuje osobę, a potem ta sama podmiana wstawia Twoją twarz. Nic nie idzie na serwer poza pobraniem modeli i, w trybie tekstowym, prośbą o obraz.

Strona: https://krz4czy.github.io/podmianka/

## Jak to liczy

Ta sama ścieżka co w [FaceFusion](https://github.com/facefusion/facefusion) dla zdjęcia:

1. Detektor SCRFD 2.5g znajduje twarz i 5 punktów.
2. ArcFace (`arcface_w600k_r50`) liczy odcisk twarzy źródłowej.
3. INSwapper 128 fp16 podmienia twarz w kadrze 128×128, z macierzą `emap` z pliku modelu.
4. Wynik wraca na zdjęcie afinicznym wklejeniem i miękką maską (pudełko jak w FaceFusion plus obrys z punktów).

Wagi nie są w tym repozytorium. Przeglądarka bierze je z [facefusion/models-3.0.0](https://huggingface.co/facefusion/models-3.0.0) i trzyma w Cache API. Razem około **435 MB** (3,1 + 166 + 265).

Licencje: `LICENSE.md` i `NOTICE.md`. FaceFusion jest na OpenRAIL-AS. Modele InsightFace są niekomercyjne. Tylko własna twarz albo za zgodą.

## Film i tekst

Film jest próbny: pierwsze 4 sekundy, dłuższy bok 480 px, 6 klatek na sekundę, bez dźwięku. Da się anulować. Zapis idzie przez MediaRecorder (`video/mp4`, gdy przeglądarka to umie, inaczej WebM).

„Stwórz z tekstu” woła `https://image.pollinations.ai/prompt/...` (bez klucza, z CORS). Do opisu dopisujemy prośbę o jedną osobę przodem. Przy limicie albo awarii jest polski komunikat.

## iPhone

Safari na iPhonie nie daje wątkom WASM bez specjalnych nagłówków, a GitHub Pages ich nie ustawia, więc modele idą jednym wątkiem. WebGPU jest używane, gdy `navigator.gpu` działa; jak nie, zostaje WASM. Zdjęcia są zmniejszane do 1280 px dłuższego boku, żeby karta zmieściła się w pamięci (około 1–1,5 GB). Pierwsze uruchomienie pobiera modele. Wynik zapisuje się z arkusza udostępniania albo przytrzymaniem obrazu.

## Uruchomienie

Statyczne pliki. GitHub Pages wstaje z akcji na `main`.

Test podmiany (modele muszą leżeć lokalnie, patrz `test/swap.test.mjs`):

```bash
npm install
npm test
```
