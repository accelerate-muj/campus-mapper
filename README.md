# Campus Mapper

An interactive map and routing application for Manipal University Jaipur. Features custom boundary locking, landmark tracing, entry point snaps, and path routing using a bidirectional Dijkstra algorithm.

## Modular Architecture

The application has been restructured from a monolithic layout into modular files:
1. **[index.html](file:///index.html)**: The HTML layout skeleton and controls container.
2. **[style.css](file:///style.css)**: CSS style rules for UI themes, layout, cards, and modal popups.
3. **[mapData.js](file:///mapData.js)**: The map data repository defining `window.BAKED_DATA`. Holds coordinates for campus boundaries, landmarks, categories, and paths (including the updated paths integrated from the new KML file).
4. **[app.js](file:///app.js)**: Core JavaScript logic (Leaflet initialization, UI handlers, drawing tools, and graph routing).

## How to Run

Because the project is built without external bundler pipelines or fetch-based JSON loadings:
- **Double-click `index.html`** to run it directly from your file system.
- It works completely offline and is compatible with the `file://` protocol without CORS errors.

## How to Update Map Data

1. Open `index.html` and use the built-in UI tools to edit, trace landmarks, or draw new buildings.
2. Click the **Copy JSON** button.
3. A popup will display the updated JavaScript code for `mapData.js`. Copy it to your clipboard.
4. Open **`mapData.js`** in a text editor and replace its entire content with the copied code.
5. Commit and push the changes to GitHub.
