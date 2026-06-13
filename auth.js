// auth.js - Handles client-side authentication UI and route protection

function getAuthUser() {
    try {
        const userStr = localStorage.getItem('swasthyasaathi_user');
        return userStr ? JSON.parse(userStr) : null;
    } catch (e) {
        return null;
    }
}

function logout() {
    localStorage.removeItem('swasthyasaathi_token');
    localStorage.removeItem('swasthyasaathi_user');
    window.location.reload();
}

// Redirects to login.html if the user is not authenticated
function requireAuth() {
    const token = localStorage.getItem('swasthyasaathi_token');
    if (!token) {
        window.location.href = 'login.html';
    }
}

// Updates the header to show the user's name instead of Login/Signup
function updateHeader() {
    const user = getAuthUser();
    if (!user) return; // Leave default Login/Signup buttons

    // Update Desktop Header
    const desktopAuthContainer = document.getElementById('desktopAuthContainer');
    if (desktopAuthContainer) {
        desktopAuthContainer.innerHTML = `
            <div class="flex items-center gap-4">
                <span class="text-sm font-bold text-slate-700 dark:text-slate-200" style="color: #475569;">Welcome, ${user.fullName.split(' ')[0]}</span>
                <button onclick="logout()" class="px-5 py-2 text-sm font-bold border border-red-500 text-red-500 rounded-full hover:bg-red-50 transition-colors cursor-pointer" style="border-color: #ef4444; color: #ef4444;">Logout</button>
            </div>
        `;
    }

    // Update Mobile Drawer
    const mobileAuthContainer = document.getElementById('mobileAuthContainer');
    if (mobileAuthContainer) {
        mobileAuthContainer.innerHTML = `
            <div class="p-4 bg-slate-100 dark:bg-slate-800 rounded-xl mb-4 text-center">
                <p class="text-sm font-bold text-slate-700 dark:text-slate-200" style="color: #475569;">Logged in as ${user.fullName}</p>
            </div>
            <button onclick="logout()" class="w-full py-3 text-sm font-bold border border-red-500 text-red-500 rounded-xl cursor-pointer" style="border-color: #ef4444; color: #ef4444;">Logout</button>
        `;
    }
}

// Automatically update header on load
document.addEventListener('DOMContentLoaded', updateHeader);
