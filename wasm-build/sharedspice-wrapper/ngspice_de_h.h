/***************************************************************************
 *   Modified (C) 2026 by EasyEDA & JLC Technology Group                      *
 *   chensiyu@sz-jlc.com                                                   *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU General Public License as published by  *
 *   the Free Software Foundation; either version 3 of the License, or     *
 *   (at your option) any later version.                                   *
 *                                                                         *
 *   This program is distributed in the hope that it will be useful,       *
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of        *
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the          *
 *   GNU General Public License for more details.                          *
 *                                                                         *
 *   You should have received a copy of the GNU General Public License     *
 *   along with this program. If not, see <http://www.gnu.org/licenses/>.  *
 ***************************************************************************/
#pragma once

#include <shared_mutex>
#include <string>
#include <vector>

#ifndef XSPICE
#define XSPICE 1
#endif

struct MeasurementData {
	std::string name;
	double value;
	std::string raw;
};

class ngspice_de {
public:
	explicit ngspice_de(const std::string &circuit, const std::string &compatMode);

	int run();
	int command(const std::string &commandText);
	void clearResultData();

	std::vector<std::string> getErrorMessages() const;
	std::vector<std::string> getWarningMessages() const;
	std::vector<MeasurementData> getMeasurements() const;

	void recordOutput(const std::string &output);
	void recordExit(int exitStatus, bool dueToQuit);

private:
	bool source(const std::string &circuit);
	void parseMeasurementLine(const std::string &line);
	void parseDiagnosticLine(const std::string &line);

	mutable std::shared_mutex mutex_;
	std::vector<std::string> errors_;
	std::vector<std::string> warnings_;
	std::vector<MeasurementData> measurements_;
	bool measurementBlockActive_ = false;
	bool ready_ = false;
};
