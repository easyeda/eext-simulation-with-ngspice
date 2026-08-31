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
#include "ngspice_de_h.h"

#include <sharedspice.h>

#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <regex>
#include <sstream>

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#endif

namespace {
constexpr int kResultProtocolVersion = 2;
constexpr size_t kMaxPointsPerVector = 100000;
const char *kInputPath = "/ngspice_de_input.cir";

std::string trim(const std::string &value) {
	const size_t start = value.find_first_not_of(" \t\r\n");
	if (start == std::string::npos) return "";
	const size_t end = value.find_last_not_of(" \t\r\n");
	return value.substr(start, end - start + 1);
}

std::string lower(const std::string &value) {
	std::string result = value;
	for (char &character : result) {
		character = static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
	}
	return result;
}

std::string withoutStreamPrefix(const std::string &value) {
	std::string text = trim(value);
	const std::string normalized = lower(text);
	for (const std::string &prefix : {"stdout", "stderr"}) {
		if (normalized.rfind(prefix, 0) != 0) continue;
		text = trim(text.substr(prefix.size()));
		while (!text.empty() && (text.front() == ':' || text.front() == '*')) text = trim(text.substr(1));
		break;
	}
	return text;
}

void appendJsonString(std::ostringstream &output, const std::string &value) {
	output << '"';
	for (unsigned char character : value) {
		switch (character) {
			case '"': output << "\\\""; break;
			case '\\': output << "\\\\"; break;
			case '\b': output << "\\b"; break;
			case '\f': output << "\\f"; break;
			case '\n': output << "\\n"; break;
			case '\r': output << "\\r"; break;
			case '\t': output << "\\t"; break;
			default:
				if (character < 0x20) {
					output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
						   << static_cast<int>(character) << std::dec << std::setfill('0');
				} else {
					output << static_cast<char>(character);
				}
		}
	}
	output << '"';
}

void appendJsonNumber(std::ostringstream &output, double value) {
	if (std::isfinite(value)) output << value;
	else output << "null";
}

void appendStringArray(std::ostringstream &output, const std::vector<std::string> &values) {
	output << '[';
	for (size_t index = 0; index < values.size(); ++index) {
		if (index) output << ',';
		appendJsonString(output, values[index]);
	}
	output << ']';
}

void appendMeasurements(std::ostringstream &output, const std::vector<MeasurementData> &measurements) {
	output << '[';
	for (size_t index = 0; index < measurements.size(); ++index) {
		if (index) output << ',';
		output << "{\"name\":";
		appendJsonString(output, measurements[index].name);
		output << ",\"value\":";
		appendJsonNumber(output, measurements[index].value);
		output << ",\"raw\":";
		appendJsonString(output, measurements[index].raw);
		output << '}';
	}
	output << ']';
}

void appendRawVector(
	std::ostringstream &output,
	const std::string &plotName,
	const std::string &vectorName,
	size_t maxPoints
) {
	std::string qualifiedName = plotName + "." + vectorName;
	pvector_info info = ngGet_Vec_Info(qualifiedName.data());
	output << "{\"name\":";
	appendJsonString(output, vectorName);
	output << ",\"qualifiedName\":";
	appendJsonString(output, qualifiedName);
	if (!info) {
		output << ",\"valueType\":\"real\",\"vectorType\":0,\"vectorFlags\":0,\"real\":[]}";
		return;
	}

	const bool complex = info->v_compdata != nullptr;
	output << ",\"valueType\":\"" << (complex ? "complex" : "real") << "\"";
	output << ",\"vectorType\":" << info->v_type;
	output << ",\"vectorFlags\":" << info->v_flags;
	if (static_cast<size_t>(info->v_length) > maxPoints) {
		output << ",\"truncated\":true,\"real\":[]";
		if (complex) output << ",\"imag\":[]";
		output << '}';
		return;
	}

	output << ",\"real\":[";
	for (int index = 0; index < info->v_length; ++index) {
		if (index) output << ',';
		if (complex) appendJsonNumber(output, info->v_compdata[index].cx_real);
		else if (info->v_realdata) appendJsonNumber(output, info->v_realdata[index]);
		else output << "null";
	}
	output << ']';
	if (complex) {
		output << ",\"imag\":[";
		for (int index = 0; index < info->v_length; ++index) {
			if (index) output << ',';
			appendJsonNumber(output, info->v_compdata[index].cx_imag);
		}
		output << ']';
	}
	output << '}';
}

#ifdef XSPICE
void appendRawEvents(std::ostringstream &output, size_t maxPoints) {
	output << ",\"events\":[";
	char **nodes = ngSpice_AllEvtNodes();
	bool firstNode = true;
	for (int nodeIndex = 0; nodes && nodes[nodeIndex]; ++nodeIndex) {
		pevt_shared_data info = ngGet_Evt_NodeInfo(nodes[nodeIndex]);
		if (!firstNode) output << ',';
		firstNode = false;
		output << "{\"name\":";
		appendJsonString(output, nodes[nodeIndex]);
		const bool truncated = info && static_cast<size_t>(info->num_steps) > maxPoints;
		if (truncated) output << ",\"truncated\":true";
		output << ",\"points\":[";
		bool firstPoint = true;
		if (info && !truncated) {
			for (int pointIndex = 0; pointIndex < info->num_steps; ++pointIndex) {
				pevt_data point = info->evt_dect[pointIndex];
				if (!point) continue;
				if (!firstPoint) output << ',';
				firstPoint = false;
				output << "{\"step\":";
				appendJsonNumber(output, point->step);
				output << ",\"dcop\":" << point->dcop << ",\"value\":";
				appendJsonString(output, point->node_value ? point->node_value : "");
				output << '}';
			}
		}
		output << "]}";
	}
	ngGet_Evt_NodeInfo(nullptr);
	output << ']';
}
#endif

bool resultExceeds(size_t maxPoints) {
	char **plots = ngSpice_AllPlots();
	for (int plotIndex = 0; plots && plots[plotIndex]; ++plotIndex) {
		const std::string plotName = plots[plotIndex];
		char **vectors = ngSpice_AllVecs(plots[plotIndex]);
		for (int vectorIndex = 0; vectors && vectors[vectorIndex]; ++vectorIndex) {
			std::string qualifiedName = plotName + "." + vectors[vectorIndex];
			pvector_info info = ngGet_Vec_Info(qualifiedName.data());
			if (info && static_cast<size_t>(info->v_length) > maxPoints) return true;
		}
	}
#ifdef XSPICE
	char **nodes = ngSpice_AllEvtNodes();
	for (int nodeIndex = 0; nodes && nodes[nodeIndex]; ++nodeIndex) {
		pevt_shared_data info = ngGet_Evt_NodeInfo(nodes[nodeIndex]);
		if (info && static_cast<size_t>(info->num_steps) > maxPoints) {
			ngGet_Evt_NodeInfo(nullptr);
			return true;
		}
	}
	ngGet_Evt_NodeInfo(nullptr);
#endif
	return false;
}

std::string buildRawResult(
	std::vector<std::string> errors,
	const std::vector<std::string> &warnings,
	const std::vector<MeasurementData> &measurements
) {
	if (resultExceeds(kMaxPointsPerVector)) {
		errors.push_back("The result contains a vector with more than 100,000 points. Reduce the simulation resolution before exporting data");
	}

	std::ostringstream output;
	output << std::setprecision(17);
	char **plots = ngSpice_AllPlots();
	const char *currentPlot = plots && plots[0] ? ngSpice_CurPlot() : nullptr;
	output << "{\"protocolVersion\":" << kResultProtocolVersion << ",\"currentPlot\":";
	if (currentPlot) appendJsonString(output, currentPlot);
	else output << "null";
	output << ",\"plots\":[";
	bool firstPlot = true;
	for (int plotIndex = 0; plots && plots[plotIndex]; ++plotIndex) {
		const std::string plotName = plots[plotIndex];
		if (!firstPlot) output << ',';
		firstPlot = false;
		output << "{\"name\":";
		appendJsonString(output, plotName);
		output << ",\"vectors\":[";
		char **vectors = ngSpice_AllVecs(plots[plotIndex]);
		for (int vectorIndex = 0; vectors && vectors[vectorIndex]; ++vectorIndex) {
			if (vectorIndex) output << ',';
			appendRawVector(output, plotName, vectors[vectorIndex], kMaxPointsPerVector);
		}
		output << "]}";
	}
	output << ']';
#ifdef XSPICE
	appendRawEvents(output, kMaxPointsPerVector);
#else
	output << ",\"events\":[]";
#endif
	output << ",\"measurements\":";
	appendMeasurements(output, measurements);
	output << ",\"diagnostics\":{\"errors\":";
	appendStringArray(output, errors);
	output << ",\"warnings\":";
	appendStringArray(output, warnings);
	output << "}}";
	return output.str();
}

ngspice_de *instance(void *userData) {
	return static_cast<ngspice_de *>(userData);
}

int sendChar(char *output, int, void *userData) {
	if (ngspice_de *circuit = instance(userData)) circuit->recordOutput(output ? output : "");
	return 0;
}

int sendStatus(char *, int, void *) { return 0; }

int controlledExit(int exitStatus, NG_BOOL, NG_BOOL dueToQuit, int, void *userData) {
	if (ngspice_de *circuit = instance(userData)) circuit->recordExit(exitStatus, dueToQuit);
	return exitStatus;
}

int sendData(pvecvaluesall, int, int, void *) { return 0; }
int sendInitData(pvecinfoall, int, void *) { return 0; }
int backgroundRunning(NG_BOOL, int, void *) { return 0; }

#ifdef XSPICE
int sendEventData(int, double, double, char *, void *, int, int, int, void *) { return 0; }
int sendInitEventData(int, int, char *, char *, int, void *) { return 0; }
#endif
} // 匿名命名空间

ngspice_de::ngspice_de(const std::string &circuit, const std::string &compatMode) {
	const int initialized = ngSpice_Init(sendChar, sendStatus, controlledExit, sendData, sendInitData, backgroundRunning, this);
#ifdef XSPICE
	if (initialized == 0) ngSpice_Init_Evt(sendEventData, sendInitEventData, this);
#endif
	if (initialized != 0) {
		recordExit(initialized, false);
		return;
	}
	/* 在网表解析(source)之前按会话设置 ngspice 兼容网表（ngbehavior）。
	 * compatMode 为空 -> 复位为默认（不兼容），否则 set ngbehavior=<mode>。 */
	if (compatMode.empty()) {
		ngSpice_Command(const_cast<char *>("unset ngbehavior"));
	} else {
		std::string command = "set ngbehavior=" + compatMode;
		ngSpice_Command(const_cast<char *>(command.c_str()));
	}
	ready_ = source(circuit);
}

bool ngspice_de::source(const std::string &circuit) {
	{
		std::ofstream deck(kInputPath, std::ios::binary | std::ios::trunc);
		if (!deck) {
			std::unique_lock<std::shared_mutex> lock(mutex_);
			errors_.push_back("Unable to create the ngspice input deck");
			return false;
		}
		deck << circuit;
		if (circuit.empty() || circuit.back() != '\n') deck << '\n';
	}
	std::string sourceCommand = std::string("source ") + kInputPath;
	const int result = ngSpice_Command(sourceCommand.data());
	if (result != 0) {
		std::unique_lock<std::shared_mutex> lock(mutex_);
		errors_.push_back("ngspice failed to load the input deck");
		return false;
	}
	return true;
}

int ngspice_de::run() {
	return ready_ ? ngSpice_Command(const_cast<char *>("run")) : -1;
}

int ngspice_de::command(const std::string &commandText) {
	if (!ready_) return -1;
	std::string mutableCommand = commandText;
	return ngSpice_Command(mutableCommand.data());
}

void ngspice_de::clearResultData() {
	{
		std::unique_lock<std::shared_mutex> lock(mutex_);
		errors_.clear();
		warnings_.clear();
		measurements_.clear();
		measurementBlockActive_ = false;
	}
	if (ready_) ngSpice_Command(const_cast<char *>("destroy all"));
}

std::vector<std::string> ngspice_de::getErrorMessages() const {
	std::shared_lock<std::shared_mutex> lock(mutex_);
	return errors_;
}

std::vector<std::string> ngspice_de::getWarningMessages() const {
	std::shared_lock<std::shared_mutex> lock(mutex_);
	return warnings_;
}

std::vector<MeasurementData> ngspice_de::getMeasurements() const {
	std::shared_lock<std::shared_mutex> lock(mutex_);
	return measurements_;
}

void ngspice_de::recordOutput(const std::string &output) {
	std::istringstream lines(output);
	std::string line;
	while (std::getline(lines, line)) {
		const std::string text = withoutStreamPrefix(line);
		if (text.empty()) continue;
		parseDiagnosticLine(text);
		parseMeasurementLine(text);
	}
}

void ngspice_de::recordExit(int exitStatus, bool dueToQuit) {
	if (dueToQuit) return;
	std::unique_lock<std::shared_mutex> lock(mutex_);
	errors_.push_back("ngspice exited unexpectedly with status " + std::to_string(exitStatus));
}

void ngspice_de::parseDiagnosticLine(const std::string &line) {
	const std::string normalized = lower(line);
	std::unique_lock<std::shared_mutex> lock(mutex_);
	if (normalized.rfind("fatal error", 0) == 0 || normalized.rfind("error:", 0) == 0) {
		errors_.push_back(line);
	} else if (normalized.rfind("warning:", 0) == 0 || normalized.rfind("warning -", 0) == 0) {
		warnings_.push_back(line);
	}
}

void ngspice_de::parseMeasurementLine(const std::string &line) {
	const std::string normalized = lower(line);
	std::unique_lock<std::shared_mutex> lock(mutex_);
	if (normalized.find("measurements for") != std::string::npos) {
		measurementBlockActive_ = true;
		return;
	}
	if (!measurementBlockActive_) return;
	if (normalized.rfind("circuit:", 0) == 0 || normalized.rfind("doing analysis", 0) == 0
		|| normalized.rfind("plot ", 0) == 0) {
		measurementBlockActive_ = false;
		return;
	}
	static const std::regex pattern(
		R"(^\s*([A-Za-z_][A-Za-z0-9_.$#:-]*)\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\b)"
	);
	std::smatch match;
	if (!std::regex_search(line, match, pattern)) return;
	measurements_.push_back({ lower(match[1].str()), std::strtod(match[2].str().c_str(), nullptr), line });
}

#ifdef __EMSCRIPTEN__
class NgSpiceWasm {
public:
	NgSpiceWasm() = default;
	~NgSpiceWasm() { reset(); }

	void loadNetlist(const std::string &netlist, const std::string &compatMode) {
		reset();
		circuit_ = new ngspice_de(netlist, compatMode);
	}

	int run() { return circuit_ ? circuit_->run() : -1; }
	int command(const std::string &commandText) { return circuit_ ? circuit_->command(commandText) : -1; }
	void clearResultData() { if (circuit_) circuit_->clearResultData(); }

	std::string getRawResultJson() const {
		if (!circuit_) {
			return "{\"protocolVersion\":2,\"currentPlot\":null,\"plots\":[],\"events\":[],\"measurements\":[],\"diagnostics\":{\"errors\":[\"ngspice not initialized\"],\"warnings\":[]}}";
		}
		return buildRawResult(circuit_->getErrorMessages(), circuit_->getWarningMessages(), circuit_->getMeasurements());
	}

	void reset() {
		delete circuit_;
		circuit_ = nullptr;
	}

private:
	ngspice_de *circuit_ = nullptr;
};

EMSCRIPTEN_BINDINGS(ngspice_wasm_bindings) {
	emscripten::class_<NgSpiceWasm>("NgSpiceWasm")
		.constructor<>()
		.function("loadNetlist", &NgSpiceWasm::loadNetlist)
		.function("run", &NgSpiceWasm::run)
		.function("command", &NgSpiceWasm::command)
		.function("clearResultData", &NgSpiceWasm::clearResultData)
		.function("getRawResultJson", &NgSpiceWasm::getRawResultJson)
		.function("reset", &NgSpiceWasm::reset);
}
#endif
