import { useState, useEffect } from 'react';

const DISCLAIMER_ACCEPTED_KEY = 'disclaimer-accepted';

export const DisclaimerModal = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const accepted = localStorage.getItem(DISCLAIMER_ACCEPTED_KEY);
    if (!accepted) {
      setVisible(true);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem(DISCLAIMER_ACCEPTED_KEY, 'true');
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <h2 style={titleStyle}>Welcome to DJI 3D Flight Planner</h2>

        <div style={contentStyle}>
          <h3 style={sectionTitle}>Terms of Use</h3>
          <p>
            By using this application you acknowledge and agree to the following terms.
            Please read them carefully before proceeding.
          </p>

          <h3 style={sectionTitle}>License &amp; Usage</h3>
          <p>
            This software is provided free of charge for <strong>personal, educational,
            and non-commercial use only</strong>. You may use it for hobby drone flights,
            personal projects, academic research, and learning purposes.
          </p>
          <p>
            <strong>Commercial use is not permitted</strong> without a separate commercial license.
            If you intend to use this software for any commercial activity — including but not
            limited to commercial surveying, mapping services, inspection services, or any
            revenue-generating operations — please contact us at{' '}
            <a href="mailto:info@droneverse.de" style={linkStyle}>info@droneverse.de</a>{' '}
            to obtain a commercial license.
          </p>

          <h3 style={sectionTitle}>Disclaimer of Liability</h3>
          <p>
            <strong>You use this software entirely at your own risk.</strong> The developers
            and operators of this application accept no responsibility or liability whatsoever
            for any damages, losses, injuries, or costs arising from the use of this software.
            This includes, but is not limited to:
          </p>
          <ul style={listStyle}>
            <li>Damage to or loss of drones, equipment, or property</li>
            <li>Crashes, collisions, or flyaway incidents</li>
            <li>Incorrect flight plans, calculations, or exported mission files</li>
            <li>Errors in altitude, terrain, coordinate, or navigation data</li>
            <li>Any personal injury or third-party claims</li>
          </ul>
          <p>
            Flight planning software can produce incorrect or unexpected results due to
            data inaccuracies, software bugs, or user configuration errors. It is your
            responsibility to verify all mission parameters, inspect flight paths, and
            ensure safe operating conditions before every flight. Always follow local
            aviation regulations and manufacturer guidelines.
          </p>

          <h3 style={sectionTitle}>Your Responsibility</h3>
          <p>
            As the pilot in command, you are solely responsible for the safe operation
            of your drone. You must review and validate every mission before uploading it
            to your drone. This software is a planning aid — it does not replace your
            judgment, situational awareness, or compliance with applicable laws.
          </p>
        </div>

        <div style={footerStyle}>
          <button onClick={handleAccept} style={buttonStyle}>
            I Understand and Accept
          </button>
        </div>
      </div>
    </div>
  );
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100vw',
  height: '100vh',
  backgroundColor: 'rgba(0, 0, 0, 0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 99999,
};

const modalStyle: React.CSSProperties = {
  backgroundColor: '#1e1e2e',
  color: '#e0e0e0',
  borderRadius: '12px',
  width: '90%',
  maxWidth: '620px',
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  border: '1px solid #333',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  padding: '20px 24px 12px',
  fontSize: '20px',
  fontWeight: 700,
  color: '#ffffff',
  borderBottom: '1px solid #333',
};

const contentStyle: React.CSSProperties = {
  padding: '16px 24px',
  overflowY: 'auto',
  fontSize: '13.5px',
  lineHeight: '1.6',
  flex: 1,
};

const sectionTitle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: '#90caf9',
  marginTop: '16px',
  marginBottom: '6px',
};

const listStyle: React.CSSProperties = {
  paddingLeft: '20px',
  margin: '8px 0',
};

const linkStyle: React.CSSProperties = {
  color: '#90caf9',
  textDecoration: 'underline',
};

const footerStyle: React.CSSProperties = {
  padding: '16px 24px',
  borderTop: '1px solid #333',
  display: 'flex',
  justifyContent: 'center',
};

const buttonStyle: React.CSSProperties = {
  padding: '10px 32px',
  fontSize: '15px',
  fontWeight: 600,
  color: '#fff',
  backgroundColor: '#1976d2',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
};
