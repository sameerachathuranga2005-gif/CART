"""
Script to create a professional Excel workbook (.xlsx) for Batagama Congregation Weekend Public Service Roster.
Includes:
1. සැප්තැම්බර් 2026 (September - Worship Center) with Gold, Green, Coral, Violet weekend themes!
2. නොවැම්බර් 2026 (November - Weligampitiya)
3. ඔක්තෝම්බර් 2026 (October - Weligampitiya)
"""
import zipfile
import xml.sax.saxutils as saxutils

def escape(s):
    return saxutils.escape(str(s))

def generate_sheet_xml(days_data, title_text):
    merges = []
    rows_xml = []
    current_row = 2

    # Title Row (Row 2)
    t_esc = escape(title_text)
    rows_xml.append(f'<row r="{current_row}" ht="38" customHeight="1">')
    for col in ["B", "C", "D", "E"]:
        val = f'<is><t>{t_esc}</t></is>' if col == 'B' else ''
        rows_xml.append(f'<c r="{col}{current_row}" s="1" t="inlineStr">{val}</c>')
    rows_xml.append('</row>')
    merges.append(f'B{current_row}:E{current_row}')
    current_row += 1

    # Empty separator row
    current_row += 1

    theme_style_map = {
        "gold": (2, 3),      # (date style, loc style)
        "green": (4, 5),
        "coral": (6, 7),
        "violet": (8, 9)
    }

    for day in days_data:
        theme = day.get("theme", "gold")
        style_date, style_loc = theme_style_map.get(theme, (2, 3))

        # Date & Location Header
        date_str = escape("දිනය : " + day["date"])
        loc_str = escape("ස්ථානය : " + day["location"])

        rows_xml.append(f'<row r="{current_row}" ht="28" customHeight="1">')
        # B & C merged for Date
        rows_xml.append(f'<c r="B{current_row}" s="{style_date}" t="inlineStr"><is><t>{date_str}</t></is></c>')
        rows_xml.append(f'<c r="C{current_row}" s="{style_date}" t="inlineStr"/>')
        merges.append(f'B{current_row}:C{current_row}')

        # D & E merged for Location
        rows_xml.append(f'<c r="D{current_row}" s="{style_loc}" t="inlineStr"><is><t>{loc_str}</t></is></c>')
        rows_xml.append(f'<c r="E{current_row}" s="{style_loc}" t="inlineStr"/>')
        merges.append(f'D{current_row}:E{current_row}')
        rows_xml.append('</row>')
        current_row += 1

        # Subheader Row: Time | Participants
        rows_xml.append(f'<row r="{current_row}" ht="24" customHeight="1">')
        rows_xml.append(f'<c r="B{current_row}" s="10" t="inlineStr"><is><t>වේලාව</t></is></c>')
        rows_xml.append(f'<c r="C{current_row}" s="11" t="inlineStr"><is><t>සහභාගිවන්නන්</t></is></c>')
        rows_xml.append(f'<c r="D{current_row}" s="11" t="inlineStr"/>')
        rows_xml.append(f'<c r="E{current_row}" s="11" t="inlineStr"/>')
        rows_xml.append('</row>')
        merges.append(f'C{current_row}:E{current_row}')
        current_row += 1

        # Slot rows
        if day.get("note"):
            note_esc = escape(day["note"])
            start_note_row = current_row
            for s_idx, slot in enumerate(day["slots"]):
                slot_time = slot["time"]
                slot_esc = escape(slot_time)
                rows_xml.append(f'<row r="{current_row}" ht="25" customHeight="1">')
                rows_xml.append(f'<c r="B{current_row}" s="14" t="inlineStr"><is><t>{slot_esc}</t></is></c>')
                if s_idx == 0:
                    rows_xml.append(f'<c r="C{current_row}" s="1" t="inlineStr"><is><t>{note_esc}</t></is></c>')
                else:
                    rows_xml.append(f'<c r="C{current_row}" s="1" t="inlineStr"/>')
                rows_xml.append(f'<c r="D{current_row}" s="1" t="inlineStr"/>')
                rows_xml.append(f'<c r="E{current_row}" s="1" t="inlineStr"/>')
                rows_xml.append('</row>')
                current_row += 1
            merges.append(f'C{start_note_row}:E{current_row - 1}')
        else:
            for s_idx, slot in enumerate(day["slots"]):
                slot_time = slot["time"]
                persons = slot["participants"]
                row_style = 12 if (s_idx % 2 == 0) else 13
                slot_esc = escape(slot_time)
                rows_xml.append(f'<row r="{current_row}" ht="25" customHeight="1">')
                rows_xml.append(f'<c r="B{current_row}" s="14" t="inlineStr"><is><t>{slot_esc}</t></is></c>')
                p1 = escape(persons[0] if len(persons) > 0 else "")
                p2 = escape(persons[1] if len(persons) > 1 else "")
                p3 = escape(persons[2] if len(persons) > 2 else "")
                rows_xml.append(f'<c r="C{current_row}" s="{row_style}" t="inlineStr"><is><t>{p1}</t></is></c>')
                rows_xml.append(f'<c r="D{current_row}" s="{row_style}" t="inlineStr"><is><t>{p2}</t></is></c>')
                rows_xml.append(f'<c r="E{current_row}" s="{row_style}" t="inlineStr"><is><t>{p3}</t></is></c>')
                rows_xml.append('</row>')
                current_row += 1

        # Spacing row
        current_row += 1

    merge_cells_xml = "".join([f'<mergeCell ref="{m}"/>' for m in merges])

    sheet_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0" showGridLines="1"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>
    <col min="1" max="1" width="3" customWidth="1"/>
    <col min="2" max="2" width="24" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="22" customWidth="1"/>
    <col min="5" max="5" width="22" customWidth="1"/>
  </cols>
  <sheetData>
    {"".join(rows_xml)}
  </sheetData>
  <mergeCells count="{len(merges)}">
    {merge_cells_xml}
  </mergeCells>
  <pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
  <pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>
</worksheet>"""
    return sheet_xml

def create_roster_xlsx(filename):
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"""

    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

    wb_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="සැප්තැම්බර් 2026 (September)" sheetId="1" r:id="rId1"/>
    <sheet name="නොවැම්බර් 2026 (November)" sheetId="2" r:id="rId2"/>
    <sheet name="ඔක්තෝම්බර් 2026 (October)" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>"""

    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="6">
    <font><name val="Segoe UI"/><sz val="11"/><color rgb="FF1E293B"/></font>
    <font><b/><name val="Segoe UI"/><sz val="15"/><color rgb="FF0F172A"/></font>
    <font><b/><name val="Segoe UI"/><sz val="11.5"/><color rgb="FF1E293B"/></font>
    <font><b/><name val="Segoe UI"/><sz val="10.5"/><color rgb="FF334155"/></font>
    <font><b/><name val="Segoe UI"/><sz val="10.5"/><color rgb="FF0F172A"/></font>
    <font><name val="Segoe UI"/><sz val="10.5"/><color rgb="FF0F172A"/></font>
  </fonts>
  <fills count="11">
    <fill><patternFill fillType="none"/></fill>
    <fill><patternFill fillType="gray125"/></fill>
    <fill><patternFill fillType="solid"><fgColor rgb="FFFACC15"/></fgColor></fill> <!-- 2: Title Gold -->
    <fill><patternFill fillType="solid"><fgColor rgb="FFEAB308"/></fgColor></fill> <!-- 3: W1 Gold Header (Deep) -->
    <fill><patternFill fillType="solid"><fgColor rgb="FF22C55E"/></fgColor></fill> <!-- 4: W2 Green Header (Deep) -->
    <fill><patternFill fillType="solid"><fgColor rgb="FFF97316"/></fgColor></fill> <!-- 5: W3 Coral Header (Deep) -->
    <fill><patternFill fillType="solid"><fgColor rgb="FF818CF8"/></fgColor></fill> <!-- 6: W4 Violet Header (Deep) -->
    <fill><patternFill fillType="solid"><fgColor rgb="FFF1F5F9"/></fgColor></fill> <!-- 7: Subheader Gray -->
    <fill><patternFill fillType="solid"><fgColor rgb="FFFFFFFF"/></fgColor></fill> <!-- 8: White -->
    <fill><patternFill fillType="solid"><fgColor rgb="FFFAFAFA"/></fgColor></fill> <!-- 9: Soft Tint -->
    <fill><patternFill fillType="solid"><fgColor rgb="FFEFF6FF"/></fgColor></fill> <!-- 10: Time Chip -->
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="15">
    <!-- 0: Default -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Main Title Banner -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 2: Gold Date (Left) -->
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center" indent="1"/>
    </xf>
    <!-- 3: Gold Location (Right) -->
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 4: Green Date (Left) -->
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center" indent="1"/>
    </xf>
    <!-- 5: Green Location (Right) -->
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 6: Coral Date (Left) -->
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center" indent="1"/>
    </xf>
    <!-- 7: Coral Location (Right) -->
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 8: Violet Date (Left) -->
    <xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center" indent="1"/>
    </xf>
    <!-- 9: Violet Location (Right) -->
    <xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 10: Col Header Time -->
    <xf numFmtId="0" fontId="3" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 11: Col Header Participants -->
    <xf numFmtId="0" fontId="3" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 12: Participant white -->
    <xf numFmtId="0" fontId="5" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 13: Participant soft tint -->
    <xf numFmtId="0" fontId="5" fillId="9" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 14: Time Cell -->
    <xf numFmtId="0" fontId="4" fillId="10" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>"""

    # Data
    september_data = [
      {
        "date": "සැප්තැම්බර් 05 වන සෙනසුරාදා 2026",
        "theme": "gold",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.00 - 8.30", "participants": ["බර්නාඩ්", "රන්දීක", "ඩිලානි"]},
          {"time": "උදේ 8.30 - 10.00", "participants": ["ඉමාරා", "තෙහාන්", "කුමුදුනී"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["ඉෂාකා", "ශශිනි", "සුහානි"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 06 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.30 - 9.00", "participants": ["සුරංග", "ලක්මාලි", "මන්දාකිණි"]},
          {"time": "උදේ 9.00 - 10.30", "participants": ["මධුශාන්", "ලක්ෂානි", "භාග්‍යා"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 12 වන සෙනසුරාදා 2026",
        "theme": "green",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.00 - 8.30", "participants": ["ශෙහාන්", "දුලානි", "ප්‍රවීන්"]},
          {"time": "උදේ 8.30 - 10.00", "participants": ["ලක්ෂිකා", "නිෂානි", "සදුනි"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["තරංග කුමාර", "සමින්ද", "තරුෂ"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 13 වන ඉරිදා 2026",
        "theme": "green",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.30 - 9.00", "participants": ["තරංග පෙරේරා", "නිරංජලා", "ෆාතිමා"]},
          {"time": "උදේ 9.00 - 10.30", "participants": ["චමින්ද", "ප්‍රභාත්", "තරිඳු"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 19 වන සෙනසුරාදා 2026",
        "theme": "coral",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.00 - 8.30", "participants": ["විතාල්", "කල්පනී", "දිනේෂ්"]},
          {"time": "උදේ 8.30 - 10.00", "participants": ["ශ්‍රේෂන්", "ලක්ෂ්මි", "කවීෂා"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["මොහාන්", "ජොසපින්", "නවෝදිනී"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 20 වන ඉරිදා 2026",
        "theme": "coral",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.30 - 9.00", "participants": ["අකිලේෂ", "සිදත්", "නිලන්ති"]},
          {"time": "උදේ 9.00 - 10.30", "participants": ["ලලිතා", "වසන්ති", "ස්නේහා"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 26 වන සෙනසුරාදා 2026",
        "theme": "violet",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.00 - 8.30", "participants": ["සුබෂ්", "රොෂේන්", "බර්නාඩ්"]},
          {"time": "උදේ 8.30 - 10.00", "participants": ["චමින්ද", "ප්‍රවීන්", "ප්‍රභාත්"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["රන්දීක", "ඩිලානි", "ඉමාරා"]}
        ]
      },
      {
        "date": "සැප්තැම්බර් 27 වන ඉරිදා 2026",
        "theme": "violet",
        "location": "නමස්කාර මධ්‍යස්ථානය",
        "slots": [
          {"time": "උදේ 7.30 - 9.00", "participants": ["තරුන්", "ශාන්ත", "මිශායෙල්"]},
          {"time": "උදේ 9.00 - 10.30", "participants": ["සමීර", "සිතුම්", "මනුෂ"]}
        ]
      }
    ]

    sheet1_xml = generate_sheet_xml(september_data, "පොදු සේවය - බටගම සභාව (සැප්තැම්බර් 2026)")

    # November
    november_data = [
      {
        "date": "නොවැම්බර් 01 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.30 - 09.00", "participants": ["රජිත", "ප්‍රියංකා", "රීටා"]},
          {"time": "උදේ 09.00 - 10.30", "participants": ["තරංග පෙරේරා", "නිරංජලා", "ෆැටීමා"]}
        ]
      },
      {
        "date": "නොවැම්බර් 07 වන සෙනසුරාදා 2026",
        "theme": "green",
        "location": "වැලිගම්පිටිය හන්දිය",
        "note": "WHQ",
        "slots": [
          {"time": "උදේ 07.00 - 08.30", "participants": ["WHQ", "", ""]},
          {"time": "උදේ 08.30 - 10.00", "participants": ["WHQ", "", ""]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["WHQ", "", ""]}
        ]
      },
      {
        "date": "නොවැම්බර් 08 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.30 - 09.00", "participants": ["ශාන්ත", "වරුණි", "මිශායෙල්"]},
          {"time": "උදේ 09.00 - 10.30", "participants": ["සමින්ද", "සංජීවනී", "තරංග"]}
        ]
      },
      {
        "date": "නොවැම්බර් 14 වන සෙනසුරාදා 2026",
        "theme": "green",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.00 - 08.30", "participants": ["රන්දික", "දිලානි", "පද්මිනී"]},
          {"time": "උදේ 08.30 - 10.00", "participants": ["තරංග කුමාර", "ඉමාරා", "තෙහාන්"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["ආශා", "මර්ල්", "භාග්‍යා"]}
        ]
      },
      {
        "date": "නොවැම්බර් 15 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.30 - 09.00", "participants": ["දුලාජ්", "ශෙරින්", "හශිනි"]},
          {"time": "උදේ 09.00 - 10.30", "participants": ["ඉෂාකා", "ස්නේහා", "ශයිනි"]}
        ]
      },
      {
        "date": "නොවැම්බර් 21 වන සෙනසුරාදා 2026",
        "theme": "green",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.00 - 08.30", "participants": ["සුරංග", "ලක්මාලි", "මන්දාකිණි"]},
          {"time": "උදේ 08.30 - 10.00", "participants": ["විතාල්", "කල්පනී", "ශ්‍රියානි බොතේජු"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["දිනේෂ්", "පවිත්‍රා", "සමීර"]}
        ]
      },
      {
        "date": "නොවැම්බර් 22 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.30 - 09.00", "participants": ["බර්නාඩ්", "ඉරෝශනි", "මනුශ"]},
          {"time": "උදේ 09.00 - 10.30", "participants": ["ප්‍රභාත්", "නිශානි", "සදුනි"]}
        ]
      },
      {
        "date": "නොවැම්බර් 28 වන සෙනසුරාදා 2026",
        "theme": "green",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.00 - 08.30", "participants": ["සිදත්", "නිලන්ති", "ලලිතා"]},
          {"time": "උදේ 08.30 - 10.00", "participants": ["ශෙහාන්", "දුලානි", "තරුන්"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["ප්‍රවීන්", "රොශිත්", "කුමුදුනි"]}
        ]
      },
      {
        "date": "නොවැම්බර් 29 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.30 - 09.00", "participants": ["රොශේන්", "සදමාලා", "මාලනි"]},
          {"time": "උදේ 09.00 - 10.30", "participants": ["ශ්‍රේෂන්", "ලක්ෂ්මි", "කවීෂා"]}
        ]
      }
    ]
    sheet2_xml = generate_sheet_xml(november_data, "පොදු සේවය - බටගම සභාව (නොවැම්බර් 2026)")

    # October
    october_data = [
      {
        "date": "ඔක්තෝම්බර් 03 වන සෙනසුරාදා 2026",
        "theme": "green",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.00 - 08.30", "participants": ["සුරංග", "ලක්මාලි", "මන්දාකිනි"]},
          {"time": "උදේ 08.30 - 10.00", "participants": ["තරංග කුමාර", "කුමාරා", "තෙහාන්"]},
          {"time": "උදේ 10.00 - 11.30", "participants": ["ඉශාකා", "ස්නේහා", "ශශිනි"]}
        ]
      },
      {
        "date": "ඔක්තෝම්බර් 04 වන ඉරිදා 2026",
        "theme": "gold",
        "location": "වැලිගම්පිටිය හන්දිය",
        "slots": [
          {"time": "උදේ 07.30 - 09.00", "participants": ["ශෙහාන්", "දුලානි", "ප්‍රවීන්"]},
          {"time": "උදේ 09.00 - 10.30", "participants": ["තරංග පෙරේරා", "නිරංජලා", "ෆාතිමා"]}
        ]
      }
    ]
    sheet3_xml = generate_sheet_xml(october_data, "පොදු සේවය - බටගම සභාව (ඔක්තෝම්බර් 2026)")

    with zipfile.ZipFile(filename, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', rels)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        z.writestr('xl/workbook.xml', workbook)
        z.writestr('xl/styles.xml', styles)
        z.writestr('xl/worksheets/sheet1.xml', sheet1_xml)
        z.writestr('xl/worksheets/sheet2.xml', sheet2_xml)
        z.writestr('xl/worksheets/sheet3.xml', sheet3_xml)

    print(f"Successfully generated {filename}")

if __name__ == "__main__":
    create_roster_xlsx("i:/sudara aiya/Weekend_Public_Service_Roster_Batagama.xlsx")
