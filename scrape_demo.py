import requests
from bs4 import BeautifulSoup
import json
import time

url = "https://admissions.nic.in/CCMT/Applicant/Report/SeatMapping.aspx?boardid=105012621"

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
})

def get_state(soup):
    viewstate = soup.find("input", {"id": "__VIEWSTATE"})['value']
    viewstategen = soup.find("input", {"id": "__VIEWSTATEGENERATOR"})['value']
    eventvalidation = soup.find("input", {"id": "__EVENTVALIDATION"})['value']
    return viewstate, viewstategen, eventvalidation

print("Loading initial page...")
response = session.get(url, timeout=10)
soup = BeautifulSoup(response.text, 'html.parser')
viewstate, viewstategen, eventvalidation = get_state(soup)

institutes_select = soup.find("select", {"id": "ctl00_ContentPlaceHolder1_ddlInstitutes"})
institutes = []
if institutes_select:
    for option in institutes_select.find_all("option"):
        if option['value'] != "--Select--":
            institutes.append((option['value'], option.text))

all_data = []
# Pick 10 top institutes for quick demo (NITs, IIITs)
for index, (inst_val, inst_text) in enumerate(institutes[:10]):
    print(f"Processing ({index+1}/10): {inst_text}")
    try:
        data1 = {
            "__EVENTTARGET": "ctl00$ContentPlaceHolder1$ddlInstitutes",
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": viewstate,
            "__VIEWSTATEGENERATOR": viewstategen,
            "__EVENTVALIDATION": eventvalidation,
            "ctl00$ContentPlaceHolder1$ddlInstitutes": inst_val
        }
        
        resp1 = session.post(url, data=data1, timeout=10)
        soup1 = BeautifulSoup(resp1.text, 'html.parser')
        v1, vg1, ev1 = get_state(soup1)
        
        dept_select = soup1.find("select", {"id": "ctl00_ContentPlaceHolder1_ddlDepartment"})
        all_dept_val = "-1"
        for opt in dept_select.find_all("option"):
            if opt.text.strip().upper() == "ALL":
                all_dept_val = opt['value']
                break
                
        data2 = {
            "__EVENTTARGET": "ctl00$ContentPlaceHolder1$ddlDepartment",
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": v1,
            "__VIEWSTATEGENERATOR": vg1,
            "__EVENTVALIDATION": ev1,
            "ctl00$ContentPlaceHolder1$ddlInstitutes": inst_val,
            "ctl00$ContentPlaceHolder1$ddlDepartment": all_dept_val
        }
        resp2 = session.post(url, data=data2, timeout=10)
        soup2 = BeautifulSoup(resp2.text, 'html.parser')
        v2, vg2, ev2 = get_state(soup2)
        
        prog_select = soup2.find("select", {"id": "ctl00_ContentPlaceHolder1_ddlMEProgram"})
        all_prog_val = "-1"
        for opt in prog_select.find_all("option"):
            if opt.text.strip().upper() == "ALL":
                all_prog_val = opt['value']
                break
                
        data3 = {
            "__EVENTTARGET": "ctl00$ContentPlaceHolder1$ddlMEProgram",
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": v2,
            "__VIEWSTATEGENERATOR": vg2,
            "__EVENTVALIDATION": ev2,
            "ctl00$ContentPlaceHolder1$ddlInstitutes": inst_val,
            "ctl00$ContentPlaceHolder1$ddlDepartment": all_dept_val,
            "ctl00$ContentPlaceHolder1$ddlMEProgram": all_prog_val
        }
        resp3 = session.post(url, data=data3, timeout=10)
        soup3 = BeautifulSoup(resp3.text, 'html.parser')
        v3, vg3, ev3 = get_state(soup3)
        
        group_select = soup3.find("select", {"id": "ctl00_ContentPlaceHolder1_ddlGroupList"})
        all_group_val = "-1"
        for opt in group_select.find_all("option"):
            if opt.text.strip().upper() == "ALL":
                all_group_val = opt['value']
                break
                
        data4 = {
            "__EVENTTARGET": "ctl00$ContentPlaceHolder1$ddlGroupList",
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": v3,
            "__VIEWSTATEGENERATOR": vg3,
            "__EVENTVALIDATION": ev3,
            "ctl00$ContentPlaceHolder1$ddlInstitutes": inst_val,
            "ctl00$ContentPlaceHolder1$ddlDepartment": all_dept_val,
            "ctl00$ContentPlaceHolder1$ddlMEProgram": all_prog_val,
            "ctl00$ContentPlaceHolder1$ddlGroupList": all_group_val
        }
        resp4 = session.post(url, data=data4, timeout=10)
        soup4 = BeautifulSoup(resp4.text, 'html.parser')
        
        table = soup4.find("table")
        if table:
            rows = table.find_all("tr")
            for row in rows[1:]:
                cols = [col.text.strip() for col in row.find_all(["th", "td"])]
                if len(cols) >= 7:
                    all_data.append({
                        "institute": cols[1],
                        "department": cols[2],
                        "pg_program": cols[3],
                        "group": cols[4],
                        "qualifying_degree": cols[5],
                        "gate_paper": cols[6]
                    })
        time.sleep(0.1)
    except Exception as e:
        print(f"Error on {inst_text}: {e}")

with open("eligibility/ccmt_mapping.json", "w", encoding="utf-8") as f:
    json.dump(all_data, f, ensure_ascii=False, indent=2)

print("Saved to eligibility/ccmt_mapping.json")

# Now let's answer the user's specific query manually so we can give them an answer:
# B.Tech in Biomedical and Robotics Engineering and GATE in CS
eligible = []
for row in all_data:
    gate = row["gate_paper"].upper()
    qd = row["qualifying_degree"].upper()
    
    if "CS" in gate or "COMPUTER SCIENCE" in gate:
        if "BIOMEDICAL" in qd or "ROBOTICS" in qd or "ANY OF THE DISCIPLINES" in qd or "ANY BRANCH" in qd:
            eligible.append(row)

print(f"\nFound {len(eligible)} courses specifically for your combination:")
for e in eligible[:5]:
    print(f"- {e['institute']}: {e['pg_program']} ({e['qualifying_degree']})")
