# TFS — Print & Document Tools Suite

A collection of web-based and local utilities for print centers, document preparation, and catalog management.

**Live Portal:** https://hxh-3mk.github.io/TFS

## Project Structure

```text
TFS/
├── index.html                  # Main web portal (GitHub Pages entry point)
├── assets/
│   └── icon.png                # Portal favicon and header icon
├── tools/                      # Standalone browser-based utilities
│   ├── Freecutter.html         # Free-form image/document cutter
│   ├── invertcolortool.html    # Color inversion tool
│   ├── exams_a4_to_a3.html     # A4-to-A3 exam layout helper
│   ├── Copy-and-Print-Centers-Price-Calculator.html  # Print & copy price calculator
│   └── audio.html              # Audio utility
├── list-main/                  # Print catalog, admin panel, and Google Drive sync
│   ├── index.html              # Public catalog view
│   ├── admin.html              # Admin management dashboard
│   ├── gdrive-sync/            # Google Apps Script sync backend
│   └── scripts/                # Sync helper scripts
└── pdf-rasterizer/             # Local Python/Flask PDF rasterization tool
    ├── app.py                  # Flask server
    ├── rasterizer.py           # PDF rasterization engine
    └── requirements.txt        # Python dependencies
```

## Components

- **Web Tools (`tools/`)**: Zero-backend HTML/JS tools accessible directly from the [live portal](https://hxh-3mk.github.io/TFS).
- **Catalog & Admin (`list-main/`)**: Print shop inventory, pricing, and Google Drive sync (`list-main/gdrive-sync/`).
- **PDF Rasterizer (`pdf-rasterizer/`)**: Local Flask app for converting/rasterizing PDFs (`pip install -r pdf-rasterizer/requirements.txt`, then run `pdf-rasterizer/run.bat`). See [`pdf-rasterizer/README.md`](pdf-rasterizer/README.md) for details.
