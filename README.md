# Podmianka

Wstawiasz siebie w inne zdjęcie: nie samą twarz, tylko osobę z Twojego zdjęcia (twarz, włosy, sylwetka, ubranie) w pozę, kadr, tło i światło drugiego zdjęcia. Jest też tryb „Stwórz z tekstu”: opisujesz scenę, a na niej ląduje osoba z Twojego zdjęcia.

To nie liczy się w telefonie. Strona jest statyczna i woła darmowy model na Hugging Face Space, bez klucza i bez backendu.

Strona, gdy GitHub Pages jest włączone: https://krz4czy.github.io/podmianka/

## Model

Główny: [AiArtLab/zen-image-edit-demo](https://huggingface.co/spaces/AiArtLab/zen-image-edit-demo) (zen-image-edit, na bazie Qwen-Image). Dwa zdjęcia i polecenie podmiany osoby. ZeroGPU, anonimowo.

Zapasowy, gdy pierwszy nie wstanie: [Qwen/Qwen-Image-Edit-2509](https://huggingface.co/spaces/Qwen/Qwen-Image-Edit-2509).

Duże modele Qwen-Image-Edit 14B na ZeroGPU w trakcie sprawdzania wywalały się przy starcie (prośba o za długi czas GPU albo błąd workera). Wan2.2-Animate nie miał działającego darmowego Space’a do podmiany osoby na filmie, więc filmu nie ma.

Zwykłe zdjęcie wraca w około pół minuty, plus kolejka. Bez konta Hugging Face limit darmowej karty jest krótki (rzędu dwóch minut GPU na dobę).

Zdjęcia są zmniejszane w przeglądarce do dłuższego boku 1024 px zanim cokolwiek wyjdzie z telefonu. Wagi nie są pobierane na urządzenie.

## Licencje

Kod strony jest nasz. Wag nie ma w repozytorium. Szczegóły w `NOTICE.md`. Używaj tylko własnego zdjęcia albo za zgodą.
